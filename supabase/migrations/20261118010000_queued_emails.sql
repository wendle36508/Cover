-- Adoption notes that have to wait (Tanner's rule, Nov 18: stay on Resend's free 100-a-day plan;
-- sign-in links come first, so sponsor emails over the daily budget wait for the next morning).
-- Owner updates already wait in item_updates; this holds already-written adoption notes.
-- Private: only Cover's server reads or writes it (it holds sponsor email addresses).

create table public.queued_emails (
  id bigint generated always as identity primary key,
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  sponsor_id uuid references public.sponsors (id) on delete cascade,
  item_id uuid references public.follow_items (id) on delete set null,
  kind text not null check (kind in ('adopted')),
  to_email text not null,
  from_line text not null,
  subject text not null,
  html text not null,
  text_body text not null,
  stop_url text not null,
  send_after timestamptz not null,
  created_at timestamptz not null default now()
);
create index queued_emails_due_idx on public.queued_emails (send_after);
alter table public.queued_emails enable row level security;
revoke all on public.queued_emails from anon, authenticated;

-- The 15-minute sender now also wakes up for waiting adoption notes.
do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'cover-send-due-updates';
    perform cron.schedule(
      'cover-send-due-updates',
      '*/15 * * * *',
      $job$
        select net.http_post(
          url := 'https://qclasffvdviuugczaway.supabase.co/functions/v1/sponsor-email',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cover_cron_secret'), '')
          ),
          body := '{"action": "send_due"}'::jsonb
        )
        where exists (select 1 from public.item_updates where status = 'queued' and send_after <= now())
           or exists (select 1 from public.queued_emails where send_after <= now());
      $job$
    );
  end if;
end;
$outer$;

-- HQ counts waiting adoption notes alongside held updates.
create or replace function public.admin_reliability() returns jsonb
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
    'updates_held', (select count(*) from public.item_updates where status = 'queued' and send_after > now())
                    + (select count(*) from public.queued_emails),
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
