-- Share previews (Tanner, Nov 23, 2026): when a link like go.covergiving.com/lucky-pup-rescue/burt is
-- pasted into Facebook, Messages or a text, those apps read the link once to build a preview card.
-- Cover's small Cloudflare helper (cloudflare/share) calls this to get just what the card needs:
-- the nonprofit's name, logo, cover photo and price, and each dog's name, tag and photo.
-- Nothing private: no sponsors, emails, amounts given or Stripe details. It answers for pages that
-- aren't live yet too, so an owner can try sharing before launch (the card is only a name and photo).

create function public.share_card(org_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'slug', n.slug,
    'name', n.name,
    'kind', n.kind,
    'is_live', n.is_live,
    'price_cents', n.monthly_price_cents,
    'nav_label', n.page->>'navLabel',
    'logo', n.page->>'logo',
    'cover_photo', n.page->>'coverPhoto',
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', i.name, 'badge', i.badge, 'photo_url', i.photo_url) order by i.sort_order, i.created_at)
      from public.follow_items i
      where i.nonprofit_id = n.id and i.status = 'active'
    ), '[]'::jsonb)
  )
  from public.nonprofits n
  where n.slug = lower(btrim(coalesce(org_slug, '')))
    and not n.is_test;
$$;
revoke execute on function public.share_card(text) from public;
grant execute on function public.share_card(text) to anon, authenticated, service_role;
