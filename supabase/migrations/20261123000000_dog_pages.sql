-- Each dog (or program) gets its own page on the sponsor page (Tanner, Nov 22, 2026): the cards show
-- just the photo, name and tag, and clicking one opens a page with more about them. These are the two
-- optional extras that page can show, filled in from the dashboard's edit box.
--   story        a longer story, plain text, up to 1,200 characters
--   more_photos  up to 6 more photos (https links to Cover's photo storage), shown under the main one
-- Same safety rules as the other columns: anyone can read them on live pages, only staff can change them.

create or replace function private.photo_links_ok(links text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(link ~ '^https://[^[:space:]"''<>]+$' and char_length(link) <= 500), true)
  from unnest(links) as link;
$$;

alter table public.follow_items
  add column story text check (char_length(story) <= 1200),
  add column more_photos text[] not null default '{}'
    check (cardinality(more_photos) <= 6 and private.photo_links_ok(more_photos));

comment on column public.follow_items.story is 'Optional longer story shown on this one''s own page (plain text, up to 1,200 characters).';
comment on column public.follow_items.more_photos is 'Up to 6 more photos for this one''s own page (https links).';
