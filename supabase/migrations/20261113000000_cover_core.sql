-- Cover core database: nonprofits, the things supporters follow, sponsors, and nonprofit staff.
--
-- Safety model (enforced by Postgres row level security, not by the website):
--   * Visitors (anon) can only READ live nonprofit pages and the things they offer to follow.
--   * Visitors never see sponsor emails or rows. Public pages get counts and display names
--     through the small functions at the bottom, which return nothing private.
--   * Sponsor records and Stripe IDs are only written by Cover's server code (service role),
--     after Stripe confirms a payment. Browsers can't create, change or delete them.
--   * Nonprofit staff (signed in) can see their own sponsors and edit their own page.

-- ---------- Tables ----------

create table public.nonprofits (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  name text not null check (char_length(name) between 2 and 120),
  place text check (char_length(place) <= 120),
  kind text not null default 'program' check (kind in ('animal', 'program')),
  monthly_price_cents integer not null default 2500 check (monthly_price_cents between 500 and 100000),
  monthly_goal_cents integer not null default 200000 check (monthly_goal_cents between 100 and 100000000),
  page jsonb not null default '{}'::jsonb,  -- headline, intro text, photos, steps, questions
  stripe_account_id text unique,            -- the nonprofit's Stripe connected account
  is_live boolean not null default false,   -- only true once Stripe says they can take payments
  created_at timestamptz not null default now()
);
comment on table public.nonprofits is 'Each nonprofit using Cover and the content of its sponsor page.';

create table public.follow_items (
  id uuid primary key default gen_random_uuid(),
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  photo_url text check (char_length(photo_url) <= 500),
  badge text check (char_length(badge) <= 40),
  note text check (char_length(note) <= 200),
  status text not null default 'active' check (status in ('active', 'finished')),
  finished_note text check (char_length(finished_note) <= 300),  -- e.g. "Bella was adopted!"
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (nonprofit_id, name)
);
comment on table public.follow_items is 'What supporters follow: an animal or a program. Money still goes to the general fund.';

create table public.sponsors (
  id uuid primary key default gen_random_uuid(),
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  item_id uuid references public.follow_items (id) on delete set null,
  first_name text not null check (char_length(first_name) between 1 and 40),
  email text not null check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'),
  show_name boolean not null default true,
  business_name text check (char_length(business_name) <= 80),
  monthly_cents integer not null check (monthly_cents > 0),
  status text not null default 'pending' check (status in ('pending', 'active', 'past_due', 'canceled')),
  stripe_checkout_session_id text unique,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.sponsors is 'Monthly sponsors. Private: only the nonprofit''s staff and Cover''s server can read them.';
create index sponsors_nonprofit_status_idx on public.sponsors (nonprofit_id, status);
create index sponsors_item_idx on public.sponsors (item_id);
create index follow_items_nonprofit_idx on public.follow_items (nonprofit_id, sort_order);

create table public.staff (
  user_id uuid not null references auth.users (id) on delete cascade,
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  role text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  primary key (user_id, nonprofit_id)
);
comment on table public.staff is 'Which signed-in users run which nonprofit.';
create index staff_nonprofit_idx on public.staff (nonprofit_id);

-- Keep sponsors.updated_at current.
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger sponsors_touch_updated_at before update on public.sponsors
  for each row execute function public.touch_updated_at();

-- ---------- Who is staff for a nonprofit ----------

create function public.is_staff(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.nonprofit_id = target and s.user_id = (select auth.uid())
  );
$$;

-- ---------- Row level security ----------

alter table public.nonprofits enable row level security;
alter table public.follow_items enable row level security;
alter table public.sponsors enable row level security;
alter table public.staff enable row level security;

-- Nonprofits: anyone sees live pages; staff also see their own page before it's live.
create policy "Live pages are public" on public.nonprofits
  for select to anon, authenticated using (is_live or public.is_staff(id));
create policy "Staff edit their own page" on public.nonprofits
  for update to authenticated using (public.is_staff(id)) with check (public.is_staff(id));

-- Things to follow: public when the page is live; staff manage their own.
create policy "Items on live pages are public" on public.follow_items
  for select to anon, authenticated using (
    exists (select 1 from public.nonprofits n where n.id = nonprofit_id and (n.is_live or public.is_staff(n.id)))
  );
create policy "Staff add items" on public.follow_items
  for insert to authenticated with check (public.is_staff(nonprofit_id));
create policy "Staff edit items" on public.follow_items
  for update to authenticated using (public.is_staff(nonprofit_id)) with check (public.is_staff(nonprofit_id));
create policy "Staff remove items" on public.follow_items
  for delete to authenticated using (public.is_staff(nonprofit_id));

-- Sponsors: only that nonprofit's staff can read them. No browser writes at all.
create policy "Staff see their sponsors" on public.sponsors
  for select to authenticated using (public.is_staff(nonprofit_id));

-- Staff: people can see which nonprofits they belong to.
create policy "See your own staff rows" on public.staff
  for select to authenticated using (user_id = (select auth.uid()));

-- Column and table permissions on top of the row rules.
revoke insert, update, delete on public.nonprofits from anon, authenticated;
grant update (name, place, kind, monthly_goal_cents, page) on public.nonprofits to authenticated;  -- never Stripe IDs or is_live
revoke insert, update, delete on public.follow_items from anon;
revoke insert, update, delete on public.sponsors from anon, authenticated;
revoke all on public.sponsors from anon;
revoke insert, update, delete on public.staff from anon, authenticated;
revoke all on public.staff from anon;

-- ---------- Public page numbers (no private data) ----------

-- Active sponsors per item, for the counts on each card.
create function public.page_item_counts(target uuid)
returns table (item_id uuid, sponsors integer)
language sql stable security definer set search_path = '' as $$
  select s.item_id, count(*)::integer
  from public.sponsors s
  join public.nonprofits n on n.id = s.nonprofit_id
  where s.nonprofit_id = target and s.status = 'active' and s.item_id is not null and n.is_live
  group by s.item_id;
$$;

-- Dollars covered this month by active sponsors.
create function public.page_monthly_covered(target uuid)
returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.monthly_cents), 0)::bigint
  from public.sponsors s
  join public.nonprofits n on n.id = s.nonprofit_id
  where s.nonprofit_id = target and s.status = 'active' and n.is_live;
$$;

-- The latest sponsors as the page shows them: business name, first name if allowed, or "A neighbor".
create function public.page_recent_sponsors(target uuid, how_many integer default 5)
returns table (display_name text, item_name text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(nullif(s.business_name, ''), case when s.show_name then s.first_name else 'A neighbor' end),
    i.name,
    s.created_at
  from public.sponsors s
  join public.nonprofits n on n.id = s.nonprofit_id
  left join public.follow_items i on i.id = s.item_id
  where s.nonprofit_id = target and s.status = 'active' and n.is_live
  order by s.created_at desc
  limit least(greatest(coalesce(how_many, 5), 0), 20);
$$;

revoke execute on function public.page_item_counts(uuid) from public;
revoke execute on function public.page_monthly_covered(uuid) from public;
revoke execute on function public.page_recent_sponsors(uuid, integer) from public;
revoke execute on function public.is_staff(uuid) from public;
grant execute on function public.page_item_counts(uuid) to anon, authenticated;
grant execute on function public.page_monthly_covered(uuid) to anon, authenticated;
grant execute on function public.page_recent_sponsors(uuid, integer) to anon, authenticated;
grant execute on function public.is_staff(uuid) to authenticated, anon;
