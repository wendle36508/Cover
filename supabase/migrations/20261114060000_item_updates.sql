-- Owner "Post update" (build step 2): a photo and one line about a dog or program, emailed to its
-- sponsors who have updates on.
--
-- Tanner's rule (Nov 14): at most one update email per dog per day (Eastern time). A second update
-- the same day isn't dropped: it's scheduled for the next free morning at 9am Eastern and sent
-- automatically by a job that runs every 15 minutes (set up in the next migration).
-- Updates are kept, so the sponsor feed (build step 4) can show them later.

create table public.item_updates (
  id uuid primary key default gen_random_uuid(),
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  item_id uuid not null references public.follow_items (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 200),
  photo_url text check (photo_url ~ '^https://[^[:space:]"''<>]+$' and char_length(photo_url) <= 500),
  created_by uuid,
  send_after timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  sent_at timestamptz,
  emailed integer not null default 0,
  created_at timestamptz not null default now()
);
comment on table public.item_updates is 'Updates a nonprofit posted about a dog or program, and when they were (or will be) emailed.';
create index item_updates_item_idx on public.item_updates (item_id, send_after desc);
create index item_updates_due_idx on public.item_updates (send_after) where status = 'queued';

alter table public.item_updates enable row level security;
create policy "Staff see their updates" on public.item_updates
  for select to authenticated using (private.is_staff(nonprofit_id));
revoke insert, update, delete on public.item_updates from anon, authenticated;
revoke all on public.item_updates from anon;

-- Post an update. Staff only. Returns when it goes out: now, or the next free morning.
create function public.post_update(target_item uuid, update_text text, update_photo text default null)
returns table (update_id uuid, send_after timestamptz, send_now boolean)
language plpgsql security definer set search_path = '' as $$
declare
  owner_nonprofit uuid;
  clean text := btrim(regexp_replace(coalesce(update_text, ''), '\s+', ' ', 'g'));
  photo text := nullif(btrim(coalesce(update_photo, '')), '');
  today date := (now() at time zone 'America/New_York')::date;
  last_day date;
  send_day date;
  goes_at timestamptz;
  new_id uuid;
begin
  select f.nonprofit_id into owner_nonprofit from public.follow_items f where f.id = target_item and f.status = 'active';
  if owner_nonprofit is null then
    raise exception 'That one isn''t on your page anymore.' using errcode = 'P0002';
  end if;
  if not private.is_staff(owner_nonprofit) then
    raise exception 'Only this nonprofit''s team can do that.' using errcode = '42501';
  end if;
  if char_length(clean) = 0 or char_length(clean) > 200 then
    raise exception 'Write one line, up to 200 characters.' using errcode = '22023';
  end if;
  if photo is not null and photo !~ '^https://[^[:space:]"''<>]+$' then
    raise exception 'That photo didn''t upload properly. Try adding it again.' using errcode = '22023';
  end if;

  -- The last day an update about this one went out (or is scheduled to).
  select max((u.send_after at time zone 'America/New_York')::date) into last_day
  from public.item_updates u
  where u.item_id = target_item and u.status in ('queued', 'sending', 'sent');

  if last_day is null or last_day < today then
    send_day := today;
    goes_at := now();
  else
    send_day := last_day + 1;
    goes_at := (send_day + time '09:00') at time zone 'America/New_York';
  end if;

  insert into public.item_updates (nonprofit_id, item_id, body, photo_url, created_by, send_after)
  values (owner_nonprofit, target_item, clean, photo, (select auth.uid()), goes_at)
  returning id into new_id;

  return query select new_id, goes_at, send_day = today;
end;
$$;
revoke execute on function public.post_update(uuid, text, text) from public, anon;
grant execute on function public.post_update(uuid, text, text) to authenticated;
