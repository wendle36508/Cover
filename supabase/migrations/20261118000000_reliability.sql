-- Reliability (approved Nov 18 2026): checkout rate limits, the nightly Stripe re-sync, and the
-- numbers Cover HQ needs to show whether everything is healthy.

-- ---------- Checkout rate limits ----------
-- Every attempt to open the card form, keyed by a hashed IP address and a hashed email (Cover's
-- server hashes them with a secret first, so this table never holds a real IP or email).
create table private.checkout_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);
create index checkout_attempts_ip_idx on private.checkout_attempts (ip_hash, created_at);
create index checkout_attempts_email_idx on private.checkout_attempts (email_hash, created_at);
create index checkout_attempts_time_idx on private.checkout_attempts (created_at);
revoke all on private.checkout_attempts from public, anon, authenticated;

-- Limits: per IP 10 an hour and 30 a day; per email 5 an hour. Returns 'ok', 'ip' or 'email'.
-- Only Cover's server (service role) can call it.
create function public.checkout_rate_check(ip_hash text, email_hash text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  verdict text := 'ok';
begin
  if (select count(*) from private.checkout_attempts a where a.ip_hash = checkout_rate_check.ip_hash and a.created_at > now() - interval '1 hour') >= 10
     or (select count(*) from private.checkout_attempts a where a.ip_hash = checkout_rate_check.ip_hash and a.created_at > now() - interval '1 day') >= 30 then
    verdict := 'ip';
  elsif (select count(*) from private.checkout_attempts a where a.email_hash = checkout_rate_check.email_hash and a.created_at > now() - interval '1 hour') >= 5 then
    verdict := 'email';
  end if;
  insert into private.checkout_attempts (ip_hash, email_hash, blocked) values (ip_hash, email_hash, verdict <> 'ok');
  delete from private.checkout_attempts where id in (
    select id from private.checkout_attempts where created_at < now() - interval '2 days' limit 500
  );
  return verdict;
end;
$$;
revoke execute on function public.checkout_rate_check(text, text) from public, anon, authenticated;
grant execute on function public.checkout_rate_check(text, text) to service_role;

-- ---------- Nightly Stripe re-sync ----------
-- Each night Cover asks Stripe for every sponsorship's real status. Anything that didn't match is
-- fixed (Stripe is the source of truth) and written here so Tanner sees it in Cover HQ.
create table public.stripe_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checked integer not null default 0,
  fixed integer not null default 0,
  errors integer not null default 0,
  note text
);
create table public.stripe_sync_issues (
  id bigint generated always as identity primary key,
  sponsor_id uuid references public.sponsors (id) on delete cascade,
  nonprofit_id uuid references public.nonprofits (id) on delete cascade,
  kind text not null check (kind in ('status_fixed', 'missed_payment_update', 'not_in_stripe', 'stripe_error')),
  cover_status text,
  stripe_status text,
  detail text,
  found_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index stripe_sync_issues_open_idx on public.stripe_sync_issues (found_at desc) where resolved_at is null;
alter table public.stripe_sync_runs enable row level security;
alter table public.stripe_sync_issues enable row level security;
revoke all on public.stripe_sync_runs, public.stripe_sync_issues from anon, authenticated;

-- The job: 7:30 UTC every night (2:30am Eastern), with the same shared secret as the update sender.
-- Only on the real Supabase project; the test database skips it.
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'cover-stripe-sync';
    perform cron.schedule(
      'cover-stripe-sync',
      '30 7 * * *',
      $job$
        select net.http_post(
          url := 'https://qclasffvdviuugczaway.supabase.co/functions/v1/stripe-sync',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cover_cron_secret'), '')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000
        );
      $job$
    );
  end if;
end;
$outer$;

-- ---------- Cover HQ: health numbers (admins only) ----------
create function public.admin_reliability() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can see this.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'emails_sent_today', (select count(*) from public.sponsor_emails where status = 'sent' and created_at >= day_start),
    'emails_failed_24h', (select count(*) from public.sponsor_emails where status = 'failed' and created_at > now() - interval '1 day'),
    'updates_held', (select count(*) from public.item_updates where status = 'queued' and send_after > now()),
    'last_webhook_at', (select max(received_at) from public.stripe_events),
    'checkout_blocked_24h', (select count(*) from private.checkout_attempts where blocked and created_at > now() - interval '1 day'),
    'last_sync', (select to_jsonb(r) from public.stripe_sync_runs r order by r.started_at desc limit 1),
    'open_issues', (
      select coalesce(jsonb_agg(x order by x.found_at desc), '[]'::jsonb) from (
        select i.id, i.kind, i.cover_status, i.stripe_status, i.detail, i.found_at, n.name as nonprofit,
               coalesce(nullif(s.business_name, ''), s.first_name) as sponsor
        from public.stripe_sync_issues i
        left join public.nonprofits n on n.id = i.nonprofit_id
        left join public.sponsors s on s.id = i.sponsor_id
        where i.resolved_at is null
        order by i.found_at desc
        limit 20
      ) x
    )
  );
end;
$$;

-- "Got it" on an HQ flag.
create function public.admin_resolve_sync_issue(issue_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can do that.' using errcode = '42501';
  end if;
  update public.stripe_sync_issues set resolved_at = now() where id = issue_id and resolved_at is null;
end;
$$;

revoke execute on function public.admin_reliability() from public, anon;
revoke execute on function public.admin_resolve_sync_issue(bigint) from public, anon;
grant execute on function public.admin_reliability() to authenticated;
grant execute on function public.admin_resolve_sync_issue(bigint) to authenticated;
