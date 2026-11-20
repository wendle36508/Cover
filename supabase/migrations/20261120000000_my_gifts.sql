-- My gifts (approved plan, Nov 20 2026): sponsors manage their own gifts from covergiving.com/gifts.html.
-- They open it with a signed link (in every Cover email, or emailed to them on request). Only Cover's
-- server reads or changes anything for them; nothing here opens new access to browsers.

-- Find every gift for one email address quickly (emails are compared lowercase).
create index sponsors_email_lower_idx on public.sponsors (lower(email));

-- Every gift for one email address, for Cover's server only (the My gifts page). Exact match, ignoring case.
create function public.gifts_for_email(target text)
returns setof public.sponsors
language sql stable security definer set search_path = '' as $$
  select * from public.sponsors s where lower(s.email) = lower(trim(target)) order by s.created_at desc;
$$;
revoke execute on function public.gifts_for_email(text) from public, anon, authenticated;
grant execute on function public.gifts_for_email(text) to service_role;

-- Stripe's card-update screen needs a small settings record on each nonprofit's Stripe account.
-- Cover creates it the first time a sponsor updates a card there, then reuses it.
alter table public.nonprofits add column stripe_portal_config text check (stripe_portal_config ~ '^bpc_[A-Za-z0-9]+$');
comment on column public.nonprofits.stripe_portal_config is 'Stripe card-update screen settings on this nonprofit''s account (not secret). Set by Cover''s server.';

-- "Email me a link to my gifts" is logged with the other sponsor-side emails, so it counts toward the
-- daily email budget. It isn't about one nonprofit, so those rows have no nonprofit.
alter table public.sponsor_emails alter column nonprofit_id drop not null;
alter table public.sponsor_emails drop constraint sponsor_emails_kind_check;
alter table public.sponsor_emails add constraint sponsor_emails_kind_check
  check (kind in ('adopted', 'update', 'manage_link'));
alter table public.sponsor_emails add constraint sponsor_emails_nonprofit_check
  check (kind = 'manage_link' or nonprofit_id is not null);

-- Limits on "email me a link": per IP 10 an hour and 30 a day; per email address 3 an hour.
-- Hashed with a secret by Cover's server first, so no real IP or email is stored. Returns 'ok', 'ip' or 'email'.
create table private.manage_link_requests (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index manage_link_requests_ip_idx on private.manage_link_requests (ip_hash, created_at);
create index manage_link_requests_email_idx on private.manage_link_requests (email_hash, created_at);
revoke all on private.manage_link_requests from public, anon, authenticated;

create function public.manage_link_rate_check(ip_hash text, email_hash text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  verdict text := 'ok';
begin
  if (select count(*) from private.manage_link_requests r where r.ip_hash = manage_link_rate_check.ip_hash and r.created_at > now() - interval '1 hour') >= 10
     or (select count(*) from private.manage_link_requests r where r.ip_hash = manage_link_rate_check.ip_hash and r.created_at > now() - interval '1 day') >= 30 then
    verdict := 'ip';
  elsif (select count(*) from private.manage_link_requests r where r.email_hash = manage_link_rate_check.email_hash and r.created_at > now() - interval '1 hour') >= 3 then
    verdict := 'email';
  end if;
  if verdict = 'ok' then
    insert into private.manage_link_requests (ip_hash, email_hash) values (ip_hash, email_hash);
  end if;
  delete from private.manage_link_requests where id in (
    select id from private.manage_link_requests where created_at < now() - interval '2 days' limit 500
  );
  return verdict;
end;
$$;
revoke execute on function public.manage_link_rate_check(text, text) from public, anon, authenticated;
grant execute on function public.manage_link_rate_check(text, text) to service_role;
