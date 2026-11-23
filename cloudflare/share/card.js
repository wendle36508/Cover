// card.js - what a shared Cover link shows as its preview card (Facebook, Messages, texts, email).
// go.covergiving.com/lucky-pup-rescue        -> "Sponsor a dog at Lucky Pup Rescue" with the cover photo
// go.covergiving.com/lucky-pup-rescue/burt   -> "Sponsor Burt at Lucky Pup Rescue" with Burt's photo
// The preview apps read this little page once and don't run code; people who tap the link are sent
// straight on to the real sponsor page. Plain code with no Cloudflare parts, so Node can test it.

import { itemSlug } from "../../docs/js/sponsor.js";

export const SITE = "https://covergiving.com";
export const SHARE_ORIGIN = "https://go.covergiving.com";
const FALLBACK_IMAGE = `${SITE}/photos/dog-smile.jpg`;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "/lucky-pup-rescue/burt" -> { org: "lucky-pup-rescue", dog: "burt" }; anything else -> null. */
export function parseSharePath(pathname) {
  const parts = String(pathname ?? "").toLowerCase().split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const [org, dog = null] = parts;
  if (!SLUG.test(org) || org.length > 60) return null;
  if (dog !== null && (!SLUG.test(dog) || dog.length > 80)) return null;
  return { org, dog };
}

/** A nonprofit's or a dog's share link: go.covergiving.com/lucky-pup-rescue(/burt). */
export function shareUrl(orgSlug, dogName = null) {
  return dogName ? `${SHARE_ORIGIN}/${orgSlug}/${itemSlug(dogName)}` : `${SHARE_ORIGIN}/${orgSlug}`;
}

/** Where a person lands: the real sponsor page (and that dog's own page). */
export function destinationUrl(orgSlug, dogName = null) {
  const url = new URL("/give.html", SITE);
  url.searchParams.set("org", orgSlug);
  if (dogName) url.searchParams.set("dog", itemSlug(dogName));
  return url.href;
}

/** "Dogs" -> "dog", "Programs" -> "program"; null if there's no useful word. */
export function singular(navLabel) {
  const word = String(navLabel ?? "").trim().toLowerCase();
  if (!word || word === "sponsor" || word.includes(" ")) return null;
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function dollars(cents) {
  const value = (Number(cents) || 0) / 100;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const httpsOnly = (url) => (typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);

/**
 * The preview card for one nonprofit (from the share_card database function), optionally one dog.
 * An unknown dog falls back to the nonprofit's card. Returns { title, description, image, shareUrl, destination }.
 */
export function cardFor(org, dogSlug = null) {
  const items = Array.isArray(org?.items) ? org.items : [];
  const dog = dogSlug ? items.find((item) => itemSlug(item.name) === dogSlug) ?? null : null;
  const price = Number(org.price_cents) > 0 ? ` for ${dollars(org.price_cents)} a month` : "";
  const one = singular(org.nav_label);
  if (dog) {
    return {
      title: `Sponsor ${dog.name} at ${org.name}`,
      description: `${dog.badge ? `${dog.badge}. ` : ""}Sponsor ${dog.name}${price} and get photos and news. Every gift goes into one fund for everyone at ${org.name}.`,
      image: httpsOnly(dog.photo_url) ?? httpsOnly(org.cover_photo) ?? FALLBACK_IMAGE,
      shareUrl: shareUrl(org.slug, dog.name),
      destination: destinationUrl(org.slug, dog.name),
    };
  }
  return {
    title: one ? `Sponsor a ${one} at ${org.name}` : `Sponsor ${org.name}`,
    description: `Monthly sponsorship${price}. Pick ${one ? `a ${one}` : "one"} to follow and get photos and news. Every gift goes into one fund for everyone at ${org.name}.`,
    image: httpsOnly(org.cover_photo) ?? httpsOnly(items.find((item) => httpsOnly(item.photo_url))?.photo_url) ?? FALLBACK_IMAGE,
    shareUrl: shareUrl(org.slug),
    destination: destinationUrl(org.slug),
  };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The little page the preview apps read: title, description and photo tags, and a script that sends
 * people on to the real page right away. No automatic redirect tag, because some preview apps follow
 * those and would then read the real page, which has no card.
 */
export function cardHtml(card, siteName) {
  const e = escapeHtml;
  const goTo = JSON.stringify(card.destination).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(card.title)}</title>
<meta name="description" content="${e(card.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${e(siteName ?? "Cover")}">
<meta property="og:title" content="${e(card.title)}">
<meta property="og:description" content="${e(card.description)}">
<meta property="og:image" content="${e(card.image)}">
<meta property="og:url" content="${e(card.shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(card.title)}">
<meta name="twitter:description" content="${e(card.description)}">
<meta name="twitter:image" content="${e(card.image)}">
<link rel="canonical" href="${e(card.shareUrl)}">
<script>location.replace(${goTo});</script>
</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
<p><a href="${e(card.destination)}">${e(card.title)}</a></p>
</body>
</html>`;
}
