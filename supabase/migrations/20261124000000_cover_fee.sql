-- Cover's 3% fee, built and switched OFF (Tanner approved Nov 22, 2026; logged in company/brain/Decisions.md).
-- After the pilot, Cover keeps 3% of each gift as a Stripe application fee on the nonprofit's own
-- account. Each nonprofit has its own switch, off by default. Only Cover admins can flip it (from HQ):
-- nonprofit staff can't, because staff may only change the columns granted to them (name, page,
-- price...), and this one isn't granted. Each gift remembers the fee it signed up with, so flipping the
-- switch later never changes what existing sponsors pay.

alter table public.nonprofits
  add column cover_fee_on boolean not null default false;
comment on column public.nonprofits.cover_fee_on is 'Cover keeps 3% of each new gift (Stripe application fee). Off by default; only Cover admins change it.';

alter table public.sponsors
  add column fee_percent smallint not null default 0 check (fee_percent between 0 and 10),
  add column covers_fee boolean not null default false;
comment on column public.sponsors.fee_percent is 'Cover''s fee on this gift when it started (0 while the fee is off).';
comment on column public.sponsors.covers_fee is 'The donor ticked "add 3% so the nonprofit gets my full gift"; monthly_cents includes that extra.';

-- HQ: switch the fee on or off for one nonprofit (new gifts only).
create function public.admin_set_cover_fee(target uuid, turn_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can change the fee.' using errcode = '42501';
  end if;
  update public.nonprofits set cover_fee_on = coalesce(turn_on, false) where id = target;
  if not found then
    raise exception 'That nonprofit doesn''t exist.' using errcode = 'P0002';
  end if;
  return coalesce(turn_on, false);
end;
$$;
revoke execute on function public.admin_set_cover_fee(uuid, boolean) from public, anon;
grant execute on function public.admin_set_cover_fee(uuid, boolean) to authenticated;

-- HQ's overview now includes each nonprofit's id and fee switch (same as before otherwise).
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
