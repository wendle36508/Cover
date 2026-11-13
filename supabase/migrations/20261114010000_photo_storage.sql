-- Photo storage: nonprofits upload photos of what supporters follow.
-- Anyone can view photos (they appear on public pages). Only a nonprofit's staff can add, change
-- or remove photos, and only inside their own folder, named after their nonprofit id.
-- Limits: images only, 5 MB each.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The folder a file is in, as a nonprofit id (or null if it isn't a valid id).
create function private.photo_owner(object_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;
grant execute on function private.photo_owner(text) to anon, authenticated;

-- Public pages load photos through their public links, which don't need a rule. This rule lets
-- staff list and replace files in their own folder (Supabase needs it for uploads that overwrite).
create policy "Staff see photos in their folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and private.is_staff(private.photo_owner(name)));
create policy "Staff upload photos to their folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and private.is_staff(private.photo_owner(name)));
create policy "Staff replace photos in their folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and private.is_staff(private.photo_owner(name)))
  with check (bucket_id = 'photos' and private.is_staff(private.photo_owner(name)));
create policy "Staff remove photos from their folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and private.is_staff(private.photo_owner(name)));
