-- Sponsor emails (approved plan, Nov 14): the "stop updates" switch, a log of every email Cover
-- sends to sponsors, and the "Mark adopted / Mark finished" move that hands sponsors to the next buddy.
--
-- Decisions (Tanner, Nov 14):
--   * "Stop updates" is per sponsorship (one dog), not per email address.
--   * The adoption note respects it: muted sponsors still move, but get no email.
--   * Money never moves. Every gift goes to the nonprofit's general fund; only the follow changes.

-- One switch per sponsorship. Stops emails only; the monthly gift keeps going.
alter table public.sponsors add column updates_off boolean not null default false;
comment on column public.sponsors.updates_off is 'True when the sponsor clicked "stop updates" for this sponsorship. Emails only, never the gift.';

-- Every email sent (or skipped) to a sponsor, for the owner's records and the one-a-day rule later.
create table public.sponsor_emails (
  id uuid primary key default gen_random_uuid(),
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  sponsor_id uuid references public.sponsors (id) on delete set null,
  item_id uuid references public.follow_items (id) on delete set null,
  kind text not null check (kind in ('adopted', 'update')),
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider_id text,  -- the email service's id for the message, for tracing a delivery problem
  created_at timestamptz not null default now()
);
comment on table public.sponsor_emails is 'Emails Cover sent (or skipped) to sponsors. Written only by Cover''s server.';
create index sponsor_emails_nonprofit_idx on public.sponsor_emails (nonprofit_id, created_at desc);

alter table public.sponsor_emails enable row level security;
create policy "Staff see their sponsor emails" on public.sponsor_emails
  for select to authenticated using (private.is_staff(nonprofit_id));
revoke insert, update, delete on public.sponsor_emails from anon, authenticated;
revoke all on public.sponsor_emails from anon;

-- "Mark adopted" / "Mark finished": done by the nonprofit's staff only, all in one step.
--   1. The item is marked finished (with the owner's optional note).
--   2. Its sponsors' follow moves to next_item (or to the nonprofit in general when next_item is null).
--   3. Returns the paying sponsors who moved, so Cover's server can email the ones with updates on.
-- Staff can't write the sponsors table directly, so this runs with the database's own rights after
-- checking the caller runs this nonprofit.
create function public.finish_item(target_item uuid, next_item uuid, finish_note text default null)
returns table (sponsor_id uuid, first_name text, email text, updates_off boolean)
language plpgsql security definer set search_path = '' as $$
declare
  owner_nonprofit uuid;
begin
  select f.nonprofit_id into owner_nonprofit
  from public.follow_items f
  where f.id = target_item and f.status = 'active';
  if owner_nonprofit is null then
    raise exception 'That one is already finished or no longer exists.' using errcode = 'P0002';
  end if;
  if not private.is_staff(owner_nonprofit) then
    raise exception 'Only this nonprofit''s team can do that.' using errcode = '42501';
  end if;
  if next_item is not null and not exists (
    select 1 from public.follow_items n
    where n.id = next_item and n.nonprofit_id = owner_nonprofit and n.status = 'active' and n.id <> target_item
  ) then
    raise exception 'Pick someone who is still on your page.' using errcode = '22023';
  end if;

  update public.follow_items
  set status = 'finished', finished_note = nullif(btrim(coalesce(finish_note, '')), '')
  where id = target_item;

  return query
  with moved as (
    update public.sponsors s
    set item_id = next_item, updated_at = now()
    where s.item_id = target_item and s.status in ('pending', 'active', 'past_due')
    returning s.id, s.first_name, s.email, s.updates_off, s.status
  )
  select m.id, m.first_name, m.email, m.updates_off
  from moved m
  where m.status in ('active', 'past_due');
end;
$$;
revoke execute on function public.finish_item(uuid, uuid, text) from public, anon;
grant execute on function public.finish_item(uuid, uuid, text) to authenticated;
