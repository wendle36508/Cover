-- Move the staff-check helper out of the public API.
-- Supabase's security checker flagged public.is_staff as callable from outside (/rest/v1/rpc/is_staff).
-- The safety rules still need it, so it moves to a "private" schema the API doesn't expose,
-- and every rule that used it is recreated to point at the private copy.
--
-- The three page_* functions stay public on purpose: they're how sponsor pages show counts,
-- the monthly total and display names, and they never return emails or private fields.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create function private.is_staff(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.nonprofit_id = target and s.user_id = (select auth.uid())
  );
$$;
revoke execute on function private.is_staff(uuid) from public;
grant execute on function private.is_staff(uuid) to anon, authenticated;

drop policy "Live pages are public" on public.nonprofits;
drop policy "Staff edit their own page" on public.nonprofits;
drop policy "Items on live pages are public" on public.follow_items;
drop policy "Staff add items" on public.follow_items;
drop policy "Staff edit items" on public.follow_items;
drop policy "Staff remove items" on public.follow_items;
drop policy "Staff see their sponsors" on public.sponsors;

create policy "Live pages are public" on public.nonprofits
  for select to anon, authenticated using (is_live or private.is_staff(id));
create policy "Staff edit their own page" on public.nonprofits
  for update to authenticated using (private.is_staff(id)) with check (private.is_staff(id));

create policy "Items on live pages are public" on public.follow_items
  for select to anon, authenticated using (
    exists (select 1 from public.nonprofits n where n.id = nonprofit_id and (n.is_live or private.is_staff(n.id)))
  );
create policy "Staff add items" on public.follow_items
  for insert to authenticated with check (private.is_staff(nonprofit_id));
create policy "Staff edit items" on public.follow_items
  for update to authenticated using (private.is_staff(nonprofit_id)) with check (private.is_staff(nonprofit_id));
create policy "Staff remove items" on public.follow_items
  for delete to authenticated using (private.is_staff(nonprofit_id));

create policy "Staff see their sponsors" on public.sponsors
  for select to authenticated using (private.is_staff(nonprofit_id));

drop function public.is_staff(uuid);
