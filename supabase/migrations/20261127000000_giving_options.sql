-- New checkout, phase 3 (Tanner, Nov 22-23, 2026): donors type any amount and pick Monthly (first),
-- Yearly or One time, and can give it as a gift to someone.
--
-- How amounts stay right everywhere:
--   amount_cents   what one charge is: $18 a month, $200 a year, or a $50 one-time gift
--   interval       'month', 'year' or 'once'
--   monthly_cents  (existing) the MONTHLY EQUIVALENT that every total already adds up:
--                  $18 a month -> 1800, $200 a year -> 1667, so "this month" totals stay true
-- One-time gifts end in the new status 'gave_once' instead of 'active', so they never count as an
-- ongoing sponsor, never get update emails, and never add to monthly totals.
-- Gift fields hold who it's for and when it should arrive (the gift email and certificate come in phase 4).

alter table public.sponsors
  add column interval text not null default 'month' check (interval in ('month', 'year', 'once')),
  add column amount_cents integer check (amount_cents > 0),
  add column gift_name text check (char_length(gift_name) between 1 and 80),
  add column gift_email text check (char_length(gift_email) <= 254 and gift_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'),
  add column gift_message text check (char_length(gift_message) <= 300),
  add column gift_send_on date,
  add constraint sponsors_gift_complete check ((gift_name is null) = (gift_email is null));

comment on column public.sponsors.interval is 'How often it''s charged: month, year or once.';
comment on column public.sponsors.amount_cents is 'What one charge is. monthly_cents is the monthly equivalent used in totals.';
comment on column public.sponsors.gift_name is 'Given as a gift: who it''s for (with gift_email, gift_message and gift_send_on).';

alter table public.sponsors drop constraint sponsors_status_check;
alter table public.sponsors add constraint sponsors_status_check
  check (status in ('pending', 'active', 'past_due', 'canceled', 'gave_once'));
