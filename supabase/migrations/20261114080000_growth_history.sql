-- Growth history for funders (Tanner, Nov 14: "keep tracking user and trend data for funding").
--
-- Two things Cover didn't keep before:
--   1. sponsor_status_changes: every time a sponsorship starts, fails a card, or cancels, a row is
--      added (sponsors only keeps the *current* status, so history was lost). This is what monthly
--      retention and churn are calculated from.
--   2. daily_metrics: one row per day (Eastern time) with the headline numbers, refreshed every hour,
--      so growth over time can be charted for funders.
-- Test pages are marked is_test and left out of every number.
-- Only Cover admins can read these. Nothing here is shown publicly.

-- ---------- Test pages don't count ----------
alter table public.nonprofits add column is_test boolean not null default false;
comment on column public.nonprofits.is_test is 'Demo or practice page. Left out of growth numbers.';
update public.nonprofits set is_test = true where slug in ('harbor-paws', 'tanner-non-profit');

-- ---------- 1. Every sponsor status change ----------
create table public.sponsor_status_changes (
  id bigint generated always as identity primary key,
  sponsor_id uuid not null references public.sponsors (id) on delete cascade,
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  from_status text,
  to_status text not null,
  monthly_cents integer not null,
  changed_at timestamptz not null default now()
);
comment on table public.sponsor_status_changes is 'History of every sponsorship status change, for retention and churn.';
create index sponsor_status_changes_time_idx on public.sponsor_status_changes (changed_at);

create function private.log_sponsor_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.sponsor_status_changes (sponsor_id, nonprofit_id, from_status, to_status, monthly_cents)
    values (new.id, new.nonprofit_id, case when tg_op = 'UPDATE' then old.status end, new.status, new.monthly_cents);
  end if;
  return new;
end;
$$;
revoke execute on function private.log_sponsor_status() from public, anon, authenticated;

create trigger sponsors_log_status
  after insert or update of status on public.sponsors
  for each row execute function private.log_sponsor_status();

-- Sponsors that already exist get one starting row (their current status, from when they signed up).
insert into public.sponsor_status_changes (sponsor_id, nonprofit_id, from_status, to_status, monthly_cents, changed_at)
select id, nonprofit_id, null, status, monthly_cents, created_at from public.sponsors;

-- ---------- 2. One row of headline numbers per day ----------
create table public.daily_metrics (
  day date primary key,
  nonprofits integer not null,          -- real (non-test) nonprofits signed up
  live_pages integer not null,          -- of those, taking payments
  active_sponsors integer not null,     -- paying sponsorships right now
  past_due_sponsors integer not null,   -- card failed, Stripe retrying
  unique_donors integer not null,       -- distinct emails among active sponsors
  monthly_cents bigint not null,        -- monthly giving flowing to nonprofits (active sponsors)
  new_sponsors integer not null,        -- sponsorships that started paying this day
  canceled_sponsors integer not null,   -- sponsorships that ended this day
  things_to_follow integer not null,    -- active dogs / programs on real pages
  finished_total integer not null,      -- dogs adopted / programs finished, all time
  emails_sent integer not null,         -- sponsor emails sent this day
  updates_posted integer not null,      -- owner updates posted this day
  recorded_at timestamptz not null default now()
);
comment on table public.daily_metrics is 'Headline numbers per day (Eastern), real nonprofits only. Refreshed hourly; the last refresh of a day is final.';

create function public.record_daily_metrics(for_day date default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target date := coalesce(for_day, (now() at time zone 'America/New_York')::date);
begin
  insert into public.daily_metrics as m (
    day, nonprofits, live_pages, active_sponsors, past_due_sponsors, unique_donors, monthly_cents,
    new_sponsors, canceled_sponsors, things_to_follow, finished_total, emails_sent, updates_posted, recorded_at
  )
  with real_np as (select id, is_live from public.nonprofits where not is_test),
  real_sponsors as (select s.* from public.sponsors s join real_np n on n.id = s.nonprofit_id),
  changes as (
    select c.* from public.sponsor_status_changes c join real_np n on n.id = c.nonprofit_id
    where (c.changed_at at time zone 'America/New_York')::date = target
  )
  select
    target,
    (select count(*) from real_np),
    (select count(*) from real_np where is_live),
    (select count(*) from real_sponsors where status = 'active'),
    (select count(*) from real_sponsors where status = 'past_due'),
    (select count(distinct lower(email)) from real_sponsors where status = 'active'),
    (select coalesce(sum(monthly_cents), 0) from real_sponsors where status = 'active'),
    (select count(*) from changes where to_status = 'active' and coalesce(from_status, 'pending') = 'pending'),
    (select count(*) from changes where to_status = 'canceled' and from_status in ('active', 'past_due')),
    (select count(*) from public.follow_items f join real_np n on n.id = f.nonprofit_id where f.status = 'active'),
    (select count(*) from public.follow_items f join real_np n on n.id = f.nonprofit_id where f.status = 'finished'),
    (select count(*) from public.sponsor_emails e join real_np n on n.id = e.nonprofit_id
       where e.status = 'sent' and (e.created_at at time zone 'America/New_York')::date = target),
    (select count(*) from public.item_updates u join real_np n on n.id = u.nonprofit_id
       where (u.created_at at time zone 'America/New_York')::date = target),
    now()
  on conflict (day) do update set
    nonprofits = excluded.nonprofits, live_pages = excluded.live_pages, active_sponsors = excluded.active_sponsors,
    past_due_sponsors = excluded.past_due_sponsors, unique_donors = excluded.unique_donors,
    monthly_cents = excluded.monthly_cents, new_sponsors = excluded.new_sponsors,
    canceled_sponsors = excluded.canceled_sponsors, things_to_follow = excluded.things_to_follow,
    finished_total = excluded.finished_total, emails_sent = excluded.emails_sent,
    updates_posted = excluded.updates_posted, recorded_at = excluded.recorded_at;
end;
$$;
revoke execute on function public.record_daily_metrics(date) from public, anon, authenticated;

-- ---------- Who can read it: Cover admins only ----------
alter table public.sponsor_status_changes enable row level security;
alter table public.daily_metrics enable row level security;
create policy "Cover admins read sponsor history" on public.sponsor_status_changes
  for select to authenticated using (private.is_cover_admin());
create policy "Cover admins read daily metrics" on public.daily_metrics
  for select to authenticated using (private.is_cover_admin());
revoke insert, update, delete on public.sponsor_status_changes, public.daily_metrics from anon, authenticated;
revoke all on public.sponsor_status_changes, public.daily_metrics from anon;

-- First row now, then refresh every hour at :05 on the real project (the test database skips this).
select public.record_daily_metrics();
do $outer$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'cover-daily-metrics';
    perform cron.schedule('cover-daily-metrics', '5 * * * *', $job$ select public.record_daily_metrics(); $job$);
  end if;
end;
$outer$;
