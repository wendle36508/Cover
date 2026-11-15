-- Sponsor recognition, part 1 (approved Nov 15): the "Thank you, sponsors" wall.
--
-- Decisions (Tanner, Nov 15):
--   * Opt-in only. The checkout box is OFF by default. We reuse sponsors.show_name as the opt-in
--     (it used to be "show my first name on this page", ticked by default).
--   * Shown as first name + last initial ("Sarah K."), or the business name for business sponsors.
--   * The owner can hide any name. The sponsor can take their name off from their emails.
--   * One wall per nonprofit. No counts and no dog names on it, so no dog ever looks "taken".
--   * The "Sarah sponsored Bella" pop-up follows the same opt-in; everyone else shows as "A neighbor".

-- The opt-in is now off unless the sponsor ticks the box. Existing rows (test data only, Nov 15)
-- never saw the new wording, so they start off too.
alter table public.sponsors alter column show_name set default false;
update public.sponsors set show_name = false where show_name;
comment on column public.sponsors.show_name is 'True when the sponsor ticked "Show my name on the thank-you wall". Off by default.';

alter table public.sponsors
  add column last_initial text check (last_initial ~ '^[A-Z]$'),
  add column wall_hidden boolean not null default false;
comment on column public.sponsors.last_initial is 'Optional last initial shown on the thank-you wall, one capital letter.';
comment on column public.sponsors.wall_hidden is 'True when the nonprofit''s team hid this name from the thank-you wall.';

-- How a sponsor's name appears in public. Null means "don't show a name".
create function private.wall_name(business_name text, first_name text, last_initial text, show_name boolean, wall_hidden boolean)
returns text
language sql immutable set search_path = '' as $$
  select case
    when not show_name or wall_hidden then null
    when nullif(business_name, '') is not null then business_name
    when last_initial is not null then first_name || ' ' || last_initial || '.'
    else first_name
  end;
$$;

-- The wall itself: newest first, names only. No amounts, no items, no counts.
create function public.page_thank_you_wall(target uuid, how_many integer default 200)
returns table (display_name text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select private.wall_name(s.business_name, s.first_name, s.last_initial, s.show_name, s.wall_hidden), s.created_at
  from public.sponsors s
  join public.nonprofits n on n.id = s.nonprofit_id
  where s.nonprofit_id = target and s.status = 'active' and n.is_live
    and s.show_name and not s.wall_hidden
  order by s.created_at desc
  limit least(greatest(coalesce(how_many, 200), 0), 500);
$$;
revoke execute on function public.page_thank_you_wall(uuid, integer) from public;
grant execute on function public.page_thank_you_wall(uuid, integer) to anon, authenticated;

-- The "Sarah sponsored Bella" pop-up: same opt-in as the wall, "A neighbor" for everyone else.
create or replace function public.page_recent_sponsors(target uuid, how_many integer default 5)
returns table (display_name text, item_name text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(private.wall_name(s.business_name, s.first_name, s.last_initial, s.show_name, s.wall_hidden), 'A neighbor'),
    i.name,
    s.created_at
  from public.sponsors s
  join public.nonprofits n on n.id = s.nonprofit_id
  left join public.follow_items i on i.id = s.item_id
  where s.nonprofit_id = target and s.status = 'active' and n.is_live
  order by s.created_at desc
  limit least(greatest(coalesce(how_many, 5), 0), 20);
$$;

-- The owner's Hide / Show button. Staff can't write sponsors directly, so this checks first.
create function public.set_wall_hidden(target_sponsor uuid, hidden boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  owner_nonprofit uuid;
begin
  select s.nonprofit_id into owner_nonprofit from public.sponsors s where s.id = target_sponsor;
  if owner_nonprofit is null then
    raise exception 'We couldn''t find that sponsor.' using errcode = 'P0002';
  end if;
  if not private.is_staff(owner_nonprofit) then
    raise exception 'Only this nonprofit''s team can do that.' using errcode = '42501';
  end if;
  update public.sponsors set wall_hidden = coalesce(hidden, false) where id = target_sponsor;
  return coalesce(hidden, false);
end;
$$;
revoke execute on function public.set_wall_hidden(uuid, boolean) from public, anon;
grant execute on function public.set_wall_hidden(uuid, boolean) to authenticated;
