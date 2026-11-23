-- New sponsor pages, phase 5 (Nov 23, 2026): the switch from the old page (give.html) to the new one
-- (sponsor.html). Each nonprofit has its own switch. Nonprofits that already exist (like Lucky Pup) stay
-- on the old page until Cover flips it in HQ; nonprofits that sign up from now on start on the new page.
-- When it's on, the old link sends visitors to the new page, so shared links, QR codes and printed signs
-- keep working. Only Cover admins can flip it (staff can't: the column isn't granted to them).

alter table public.nonprofits add column new_page boolean not null default false;
alter table public.nonprofits alter column new_page set default true;
comment on column public.nonprofits.new_page is 'Uses the new sponsor page (sponsor.html); the old link forwards there. Only Cover admins change it.';

-- HQ: switch one nonprofit to the new page, or back.
create function public.admin_set_new_page(target uuid, turn_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can switch pages.' using errcode = '42501';
  end if;
  update public.nonprofits set new_page = coalesce(turn_on, false) where id = target;
  if not found then
    raise exception 'That nonprofit doesn''t exist.' using errcode = 'P0002';
  end if;
  return coalesce(turn_on, false);
end;
$$;
revoke execute on function public.admin_set_new_page(uuid, boolean) from public, anon;
grant execute on function public.admin_set_new_page(uuid, boolean) to authenticated;

-- HQ's overview now also says which page each nonprofit uses (same as before otherwise).
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
