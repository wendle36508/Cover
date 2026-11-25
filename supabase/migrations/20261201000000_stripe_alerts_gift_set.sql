-- Stripe account alerts and gift confirmations (Nov 25, 2026; Tanner approved both daily suggestions).
--   1. When Stripe tells Cover a nonprofit's account changed (account.updated), the page turns on or off
--      to match, and if Stripe needs something, the owner and Cover get one plain-English email.
--      stripe_alerts remembers what was asked, so the same problem is emailed only once. Private:
--      only Cover's server reads it (HQ shows it through admin_overview).
--   2. Someone who buys a gift sponsorship gets a "your gift is set" note right after paying, sent by
--      the same job as welcome emails (so welcome_emails_due now includes gifts; the code picks the email).

create table public.stripe_alerts (
  nonprofit_id uuid primary key references public.nonprofits (id) on delete cascade,
  key text not null,
  message text not null,
  raised_at timestamptz not null default now()
);
comment on table public.stripe_alerts is 'What Stripe currently needs from a nonprofit (one row each). Emailed once per new request.';
alter table public.stripe_alerts enable row level security;
revoke all on public.stripe_alerts from anon, authenticated;

alter table public.queued_emails drop constraint queued_emails_kind_check;
alter table public.queued_emails add constraint queued_emails_kind_check check (kind in ('adopted', 'stripe_alert'));
alter table public.sponsor_emails drop constraint sponsor_emails_kind_check;
alter table public.sponsor_emails add constraint sponsor_emails_kind_check
  check (kind in ('adopted', 'update', 'manage_link', 'welcome', 'gift', 'reminder', 'stripe_alert', 'gift_set'));

-- Welcome emails due now include gifts: the buyer of a gift gets "your gift is set" instead of a welcome.
create or replace function public.welcome_emails_due(max_rows integer default 50) returns setof public.sponsors
language sql stable security definer set search_path = '' as $$
  select s.* from public.sponsors s join public.nonprofits n on n.id = s.nonprofit_id
  where not n.is_test and s.status in ('active', 'gave_once') and s.certificate_sent_at is null
    and s.created_at > now() - interval '30 days'
  order by s.created_at limit greatest(1, least(max_rows, 200));
$$;

-- HQ's overview now also shows what Stripe needs from each nonprofit, if anything (same as before otherwise).
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can see HQ.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'totals', (
      select jsonb_build_object(
        'nonprofits', (select count(*) from public.nonprofits),
        'live_pages', (select count(*) from public.nonprofits where is_live),
        'payouts_started', (select count(*) from public.nonprofits where stripe_account_id is not null),
        'active_sponsors', count(*) filter (where s.status = 'active'),
        'monthly_cents', coalesce(sum(s.monthly_cents) filter (where s.status = 'active'), 0),
        'new_sponsors_7d', count(*) filter (where s.status = 'active' and s.created_at > now() - interval '7 days'),
        'waiting_on_payment', count(*) filter (where s.status = 'pending' and s.created_at > now() - interval '1 day'),
        'card_failed', count(*) filter (where s.status = 'past_due'),
        'canceled_30d', count(*) filter (where s.status = 'canceled' and s.updated_at > now() - interval '30 days'),
        'pending_invites', (select count(*) from public.staff_invites),
        'needs_review', (select count(*) from public.stripe_events where needs_review)
      )
      from public.sponsors s
    ),
    'nonprofits', coalesce((
      select jsonb_agg(row_data order by (row_data->>'created_at') desc)
      from (
        select jsonb_build_object(
          'id', n.id,
          'name', n.name,
          'cover_fee_on', n.cover_fee_on,
          'new_page', n.new_page,
          'stripe_alert', (select a.message from public.stripe_alerts a where a.nonprofit_id = n.id),
          'slug', n.slug,
          'is_live', n.is_live,
          'payouts_started', n.stripe_account_id is not null,
          'created_at', n.created_at,
          'things_to_follow', (select count(*) from public.follow_items i where i.nonprofit_id = n.id and i.status = 'active'),
          'with_photos', (select count(*) from public.follow_items i where i.nonprofit_id = n.id and i.status = 'active' and i.photo_url is not null),
          'active_sponsors', (select count(*) from public.sponsors s where s.nonprofit_id = n.id and s.status = 'active'),
          'monthly_cents', (select coalesce(sum(s.monthly_cents), 0) from public.sponsors s where s.nonprofit_id = n.id and s.status = 'active'),
          'card_failed', (select count(*) from public.sponsors s where s.nonprofit_id = n.id and s.status = 'past_due'),
          'owner_joined', exists (select 1 from public.staff st where st.nonprofit_id = n.id and st.role = 'owner'),
          'invite_pending', exists (select 1 from public.staff_invites iv where iv.nonprofit_id = n.id)
        ) as row_data
        from public.nonprofits n
      ) rows
    ), '[]'::jsonb),
    'recent_sponsors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', coalesce(nullif(s.business_name, ''), s.first_name),
        'business', s.business_name is not null,
        'nonprofit', n.name,
        'following', i.name,
        'status', s.status,
        'monthly_cents', s.monthly_cents,
        'created_at', s.created_at
      ) order by s.created_at desc)
      from (select * from public.sponsors order by created_at desc limit 12) s
      join public.nonprofits n on n.id = s.nonprofit_id
      left join public.follow_items i on i.id = s.item_id
    ), '[]'::jsonb),
    'review_events', coalesce((
      select jsonb_agg(jsonb_build_object('type', e.type, 'received_at', e.received_at) order by e.received_at desc)
      from (select * from public.stripe_events where needs_review order by received_at desc limit 20) e
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
