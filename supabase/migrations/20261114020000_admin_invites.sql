-- "Cover sets it up for them": Cover admins (Tanner) create a nonprofit's page, add its dogs and
-- photos, then invite the owner by email. When the owner signs in, the invite is claimed and they
-- become the page's owner. Their only job is setting up payouts.

-- ---------- Cover admins ----------

create table public.cover_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.cover_admins is 'People who run Cover itself and can set up pages for nonprofits.';
alter table public.cover_admins enable row level security;
revoke all on public.cover_admins from anon, authenticated;

create function private.is_cover_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cover_admins where user_id = (select auth.uid()));
$$;
grant execute on function private.is_cover_admin() to anon, authenticated;

-- So the dashboard can show admin tools only to admins (true or false, nothing else).
create function public.am_i_cover_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_cover_admin();
$$;
revoke execute on function public.am_i_cover_admin() from public, anon;
grant execute on function public.am_i_cover_admin() to authenticated;

-- ---------- one set of checks for every way a nonprofit is created ----------

create function private.new_nonprofit(
  nonprofit_name text, page_slug text, page_kind text, follow_label text, price_cents integer, goal_cents integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  clean_name text := btrim(regexp_replace(coalesce(nonprofit_name, ''), '\s+', ' ', 'g'));
  clean_slug text := lower(btrim(coalesce(page_slug, '')));
  clean_label text := btrim(coalesce(follow_label, ''));
  new_id uuid;
begin
  if char_length(clean_name) not between 2 and 120 then
    raise exception 'The nonprofit''s name should be 2 to 120 characters.' using errcode = 'P0001';
  end if;
  if clean_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(clean_slug) not between 3 and 60 then
    raise exception 'The page link can only use lowercase letters, numbers and dashes (3 to 60 characters).' using errcode = 'P0001';
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
  return new_id;
end;
$$;
revoke execute on function private.new_nonprofit(text, text, text, text, integer, integer) from public, anon, authenticated;

-- Self sign-up now uses the shared checks (same rules and messages as before).
create or replace function public.create_my_nonprofit(
  nonprofit_name text, page_slug text, page_kind text default 'program', follow_label text default 'Programs',
  price_cents integer default 2500, goal_cents integer default 200000
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  new_id uuid;
begin
  if me is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if exists (select 1 from public.staff where user_id = me) then
    raise exception 'You already run a nonprofit on Cover.' using errcode = 'P0001';
  end if;
  new_id := private.new_nonprofit(nonprofit_name, page_slug, page_kind, follow_label, price_cents, goal_cents);
  insert into public.staff (user_id, nonprofit_id, role) values (me, new_id, 'owner');
  return (select slug from public.nonprofits where id = new_id);
end;
$$;

-- Admins create pages for nonprofits (any number), joining each as a helper ("admin" role).
create function public.admin_create_nonprofit(
  nonprofit_name text, page_slug text, page_kind text default 'program', follow_label text default 'Programs',
  price_cents integer default 2500, goal_cents integer default 200000
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can do this.' using errcode = '42501';
  end if;
  new_id := private.new_nonprofit(nonprofit_name, page_slug, page_kind, follow_label, price_cents, goal_cents);
  insert into public.staff (user_id, nonprofit_id, role) values ((select auth.uid()), new_id, 'admin');
  return new_id;
end;
$$;
revoke execute on function public.admin_create_nonprofit(text, text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_create_nonprofit(text, text, text, text, integer, integer) to authenticated;

-- ---------- owner invites ----------

create table public.staff_invites (
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  email text not null check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'),
  role text not null default 'owner' check (role in ('owner', 'admin')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (nonprofit_id, email)
);
comment on table public.staff_invites is 'People invited to run a nonprofit page, waiting for their first sign-in.';
alter table public.staff_invites enable row level security;
revoke all on public.staff_invites from anon;
revoke insert, update, delete on public.staff_invites from authenticated;
create policy "Staff see their nonprofit's invites" on public.staff_invites
  for select to authenticated using (private.is_staff(nonprofit_id));

-- Invite someone to run a nonprofit page. Any of its staff can invite; repeats are harmless.
create function public.invite_to_nonprofit(target uuid, invite_email text, invite_role text default 'owner')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean_email text := lower(btrim(coalesce(invite_email, '')));
begin
  if not private.is_staff(target) then
    raise exception 'You can only invite people to your own nonprofit.' using errcode = '42501';
  end if;
  if clean_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' or char_length(clean_email) > 254 then
    raise exception 'That email doesn''t look right.' using errcode = 'P0001';
  end if;
  if invite_role not in ('owner', 'admin') then
    raise exception 'Unknown role.' using errcode = 'P0001';
  end if;
  insert into public.staff_invites (nonprofit_id, email, role, invited_by)
  values (target, clean_email, invite_role, (select auth.uid()))
  on conflict (nonprofit_id, email) do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now();
end;
$$;
revoke execute on function public.invite_to_nonprofit(uuid, text, text) from public, anon;
grant execute on function public.invite_to_nonprofit(uuid, text, text) to authenticated;

create function public.cancel_invite(target uuid, invite_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_staff(target) then
    raise exception 'You can only change your own nonprofit''s invites.' using errcode = '42501';
  end if;
  delete from public.staff_invites where nonprofit_id = target and email = lower(btrim(invite_email));
end;
$$;
revoke execute on function public.cancel_invite(uuid, text) from public, anon;
grant execute on function public.cancel_invite(uuid, text) to authenticated;

-- Called when someone signs in: turns invites for their email into staff access. Returns how many.
create function public.claim_my_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  my_email text;
  claimed integer;
begin
  if me is null then
    return 0;
  end if;
  select lower(email) into my_email from auth.users where id = me;
  if my_email is null then
    return 0;
  end if;
  insert into public.staff (user_id, nonprofit_id, role)
  select me, i.nonprofit_id, i.role from public.staff_invites i where i.email = my_email
  on conflict (user_id, nonprofit_id) do nothing;
  get diagnostics claimed = row_count;
  delete from public.staff_invites where email = my_email;
  return claimed;
end;
$$;
revoke execute on function public.claim_my_invites() from public, anon;
grant execute on function public.claim_my_invites() to authenticated;
