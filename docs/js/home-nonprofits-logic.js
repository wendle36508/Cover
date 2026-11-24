// home-nonprofits-logic.js - the rules behind the homepage's live nonprofits section, kept apart from
// the page so Node can test them: tidy what the database sends, the "Sponsor a dog" line, the links,
// and whether to show one big featured card or a grid.

import { safeImageUrl } from "./brand.js";
import { pageSettings } from "./templates.js";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const FEATURED_DOGS = 4;

/** Only rows that can make a working card: a real link and a name. Bad photos are dropped, never shown blank. */
export function cleanNonprofits(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((n) => n && SLUG_PATTERN.test(n.slug ?? "") && typeof n.name === "string" && n.name.trim())
    .map((n) => ({
      slug: n.slug,
      name: n.name.trim(),
      place: typeof n.place === "string" && n.place.trim() ? n.place.trim() : "",
      logo: safeImageUrl(n.logo),
      coverPhoto: safeImageUrl(n.cover_photo),
      brandColor: typeof n.brand_color === "string" ? n.brand_color : null,
      headline: typeof n.headline === "string" ? n.headline.trim() : "",
      one: pageSettings({ kind: n.kind, template: n.template, navLabel: n.nav_label }).one,
      items: (Array.isArray(n.items) ? n.items : [])
        .map((i) => ({ name: typeof i?.name === "string" ? i.name : "", photo: safeImageUrl(i?.photo_url), focus: `${i?.focus_x ?? 50}% ${i?.focus_y ?? 38}%` }))
        .filter((i) => i.name && i.photo)
        .slice(0, FEATURED_DOGS),
    }));
}

/** "Sponsor a dog", "Sponsor a program". */
export function sponsorLine(nonprofit) {
  return `Sponsor a ${nonprofit.one}`;
}

/** The nonprofit's page, or one dog on it. */
export function pageLink(nonprofit, itemName = null) {
  const params = new URLSearchParams({ org: nonprofit.slug });
  if (itemName) params.set("dog", itemName);
  return `give.html?${params}`;
}

/** "hidden" with none live, "featured" (one big card with a few of its dogs) with one, "grid" after that. */
export function layoutFor(count) {
  if (!count) return "hidden";
  return count === 1 ? "featured" : "grid";
}
