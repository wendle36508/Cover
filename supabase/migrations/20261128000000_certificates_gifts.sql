-- New sponsor pages, phase 4 (Nov 23, 2026): after someone signs up.
--   1. A welcome email with a printable photo certificate (sponsor's name, their pick's photo, the date).
--   2. Gifts: on the day the giver picked, the person it's for gets an email with the certificate and the
--      giver's message. From then on, updates and adoption notes go to them, not the giver.
--   3. Update reminders: the nonprofit picks when its updates go out (like Dogs Trust's three a year), and
--      Cover emails the owner a week before each one. update_reminders remembers which were sent.
-- All sending happens in the sponsor-email function under the same daily email budget as everything else.

alter table public.sponsors
  add column certificate_sent_at timestamptz,
  add column gift_sent_at timestamptz;
comment on column public.sponsors.certificate_sent_at is 'When the welcome email with the photo certificate went out.';
comment on column public.sponsors.gift_sent_at is 'When the gift email reached the person it''s for (updates go to them from then on).';

-- Gifts and sponsors from before this change never get a surprise welcome email.
update public.sponsors set certificate_sent_at = coalesce(certificate_sent_at, now()) where status in ('active', 'past_due', 'canceled');

-- Welcome emails due: new, paid, not a gift (gifts get their own email), real pages only.
create function public.welcome_emails_due(max_rows integer default 50) returns setof public.sponsors
language sql stable security definer set search_path = '' as $$
  select s.* from public.sponsors s join public.nonprofits n on n.id = s.nonprofit_id
  where not n.is_test and s.status in ('active', 'gave_once') and s.certificate_sent_at is null
    and s.gift_name is null and s.created_at > now() - interval '30 days'
  order by s.created_at limit greatest(1, least(max_rows, 200));
$$;

-- Gift emails due: paid, and the chosen day has come (Eastern time, where Cover's pilots are).
create function public.gift_emails_due(max_rows integer default 50) returns setof public.sponsors
language sql stable security definer set search_path = '' as $$
  select s.* from public.sponsors s join public.nonprofits n on n.id = s.nonprofit_id
  where not n.is_test and s.status in ('active', 'gave_once', 'past_due') and s.gift_name is not null and s.gift_sent_at is null
    and coalesce(s.gift_send_on, s.created_at::date) <= (now() at time zone 'America/New_York')::date
  order by s.gift_send_on nulls first limit greatest(1, least(max_rows, 200));
$$;

revoke all on function public.welcome_emails_due(integer) from public, anon, authenticated;
revoke all on function public.gift_emails_due(integer) from public, anon, authenticated;
grant execute on function public.welcome_emails_due(integer) to service_role;
grant execute on function public.gift_emails_due(integer) to service_role;

create table public.update_reminders (
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  due_on date not null,
  sent_at timestamptz not null default now(),
  primary key (nonprofit_id, due_on)
);
comment on table public.update_reminders is 'Reminders sent to owners before each scheduled update (one per nonprofit per due date).';
alter table public.update_reminders enable row level security;
revoke all on public.update_reminders from anon, authenticated;

-- The 15-minute sender also wakes up for welcome and gift emails; a daily job sends owner reminders.
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
           or exists (select 1 from public.queued_emails where send_after <= now())
           or exists (select 1 from public.welcome_emails_due(1))
           or exists (select 1 from public.gift_emails_due(1));
      $job$
    );
    perform cron.unschedule(jobid) from cron.job where jobname = 'cover-update-reminders';
    perform cron.schedule(
      'cover-update-reminders',
      '0 14 * * *', -- 9am Eastern in winter
      $job$
        select net.http_post(
          url := 'https://qclasffvdviuugczaway.supabase.co/functions/v1/sponsor-email',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cover_cron_secret'), '')
          ),
          body := '{"action": "reminders"}'::jsonb
        );
      $job$
    );
  end if;
end;
$outer$;

-- The email log accepts the new kinds.
alter table public.sponsor_emails drop constraint sponsor_emails_kind_check;
alter table public.sponsor_emails add constraint sponsor_emails_kind_check
  check (kind in ('adopted', 'update', 'manage_link', 'welcome', 'gift', 'reminder'));
alter table public.sponsor_emails drop constraint sponsor_emails_nonprofit_check;
alter table public.sponsor_emails add constraint sponsor_emails_nonprofit_check
  check (kind = 'manage_link' or nonprofit_id is not null);
