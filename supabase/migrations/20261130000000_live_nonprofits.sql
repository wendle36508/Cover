-- The homepage's "Sponsor a local nonprofit" section (Nov 24, 2026): every LIVE, real nonprofit on Cover.
-- One public function returns only what the homepage shows: name, link, town, logo, cover photo, color,
-- what supporters follow, and up to 4 photos with names. No sponsor data, no counts, no emails, no money.
-- Test pages (is_test) never appear. The made-up demo pages aren't in the database at all.

create function public.live_nonprofits() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', n.slug,
    'name', n.name,
    'place', n.place,
    'kind', n.kind,
    'logo', n.page->>'logo',
    'cover_photo', n.page->>'coverPhoto',
    'brand_color', n.page->>'brandColor',
    'nav_label', n.page->>'navLabel',
    'template', n.page->>'template',
    'headline', n.page->>'headline',
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', i.name, 'photo_url', i.photo_url, 'focus_x', i.photo_focus_x, 'focus_y', i.photo_focus_y)
                       order by i.sort_order, i.created_at)
      from (
        select f.name, f.photo_url, f.photo_focus_x, f.photo_focus_y, f.sort_order, f.created_at
        from public.follow_items f
        where f.nonprofit_id = n.id and f.status = 'active' and f.photo_url is not null
        order by f.sort_order, f.created_at
        limit 4
      ) i
    ), '[]'::jsonb)
  ) order by n.created_at), '[]'::jsonb)
  from public.nonprofits n
  where n.is_live and not n.is_test;
$$;
comment on function public.live_nonprofits() is 'Public list of live, real nonprofits for the homepage. Names, links and photos only.';
revoke all on function public.live_nonprofits() from public;
grant execute on function public.live_nonprofits() to anon, authenticated;
