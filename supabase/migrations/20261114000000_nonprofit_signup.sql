-- Nonprofit sign-up: a signed-in person creates their nonprofit and becomes its owner.
-- Browsers can't insert nonprofits directly (see cover_core), so sign-up goes through this one
-- function, which checks everything and never lets anyone set Stripe ids or switch a page live.

create function public.create_my_nonprofit(
  nonprofit_name text,
  page_slug text,
  page_kind text default 'program',
  follow_label text default 'Programs',
  price_cents integer default 2500,
  goal_cents integer default 200000
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  clean_name text := btrim(regexp_replace(coalesce(nonprofit_name, ''), '\s+', ' ', 'g'));
  clean_slug text := lower(btrim(coalesce(page_slug, '')));
  clean_label text := btrim(coalesce(follow_label, ''));
  new_id uuid;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if exists (select 1 from public.staff where user_id = me) then
    raise exception 'You already run a nonprofit on Cover.' using errcode = 'P0001';
  end if;
  if char_length(clean_name) not between 2 and 120 then
    raise exception 'Your nonprofit''s name should be 2 to 120 characters.' using errcode = 'P0001';
  end if;
  if clean_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(clean_slug) not between 3 and 60 then
    raise exception 'Your page link can only use lowercase letters, numbers and dashes (3 to 60 characters).' using errcode = 'P0001';
  end if;
  if page_kind not in ('animal', 'program') then
    raise exception 'Pick animals or programs.' using errcode = 'P0001';
  end if;
  if char_length(clean_label) not between 2 and 30 then
    raise exception 'What supporters follow should be 2 to 30 characters, like "Dogs" or "Programs".' using errcode = 'P0001';
  end if;
  if price_cents is null or price_cents not between 500 and 100000 then
    raise exception 'The monthly amount should be between $5 and $1,000.' using errcode = 'P0001';
  end if;
  if goal_cents is null or goal_cents not between 100 and 100000000 then
    raise exception 'The monthly goal should be between $1 and $1,000,000.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.nonprofits where slug = clean_slug) then
    raise exception 'That page link is taken. Try another.' using errcode = 'P0001';
  end if;

  insert into public.nonprofits (slug, name, kind, monthly_price_cents, monthly_goal_cents, page, is_live)
  values (clean_slug, clean_name, page_kind, price_cents, goal_cents,
          jsonb_build_object('navLabel', clean_label, 'listTitle', 'Pick one to follow.'), false)
  returning id into new_id;
  insert into public.staff (user_id, nonprofit_id, role) values (me, new_id, 'owner');
  return clean_slug;
end;
$$;

revoke execute on function public.create_my_nonprofit(text, text, text, text, integer, integer) from public, anon;
grant execute on function public.create_my_nonprofit(text, text, text, text, integer, integer) to authenticated;

-- Staff can also set their nonprofit's monthly amount (Stripe IDs and the live switch stay server-only).
grant update (monthly_price_cents) on public.nonprofits to authenticated;
