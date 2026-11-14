// brand.js - a nonprofit's own look: brand color, logo, links and thank-you note.
// Pure functions (no page access), so they're tested on their own and shared by the
// dashboard and the donor page. Everything a nonprofit types is checked here before it's
// shown to donors: colors must be real hex colors and links must be plain https addresses.

export const BRAND_SWATCHES = ["#22C67A", "#E8743B", "#2F6FDB", "#7B4FC9", "#D6406B", "#14181C"];
export const THANKS_MAX = 300;
const INK = "#14181C";
const WHITE = "#FFFFFF";
const READABLE = 4.5; // the usual minimum contrast for normal-size text

/** "#e8743b", "E8743B" or "#e73" -> "#E8743B". Anything else -> null. */
export function normalizeHex(input) {
  const raw = String(input ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) return `#${[...raw].map((c) => c + c).join("")}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** How bright a color looks to the eye, 0 (black) to 1 (white). */
function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast between two colors, from 1 (same) to 21 (black on white). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend a color toward another; amount 0 = unchanged, 1 = fully the other color. */
function mix(hex, toward, amount) {
  const from = channels(hex);
  const to = channels(toward);
  return toHex(from.map((v, i) => v + (to[i] - v) * amount));
}

/**
 * The page colors for a brand color: buttons and bars use it, text on white uses a darker
 * shade that stays readable, light backgrounds use a pale tint, and button text is dark or
 * white, whichever reads better. Returns null for a bad color (the page keeps Cover green).
 */
export function brandColors(input) {
  const color = normalizeHex(input);
  if (!color) return null;
  let dark = color;
  for (let step = 0; contrast(dark, WHITE) < READABLE && step < 20; step += 1) dark = mix(dark, "#000000", 0.08);
  return {
    "--green": color,
    "--green-dark": dark,
    "--mint": mix(color, WHITE, 0.88),
    "--on-green": contrast(color, INK) >= contrast(color, WHITE) ? INK : WHITE,
  };
}

/** Put the brand colors on an element (usually the page), or take them off for a bad color. */
export function applyBrand(element, input) {
  const colors = brandColors(input);
  for (const name of ["--green", "--green-dark", "--mint", "--on-green"]) {
    if (colors) element.style.setProperty(name, colors[name]);
    else element.style.removeProperty(name);
  }
}

/** A website someone typed -> a safe https link, or null. "harborpaws.org" works. */
export function websiteLink(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) return null;
  url.protocol = "https:";
  return { href: url.href, label: url.hostname.replace(/^www\./, "") };
}

/** An Instagram or Facebook handle or link -> a safe https link to that profile, or null. */
export function socialLink(site, input) {
  const hosts = { instagram: "instagram.com", facebook: "facebook.com" };
  const host = hosts[site];
  const raw = String(input ?? "").trim();
  if (!host || !raw) return null;
  const handle = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.|m\.)?(instagram\.com|facebook\.com|fb\.com)\/?/i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) return null;
  return { href: `https://${host}/${handle}`, label: site === "instagram" ? "Instagram" : "Facebook" };
}

/** All of a nonprofit's links that are safe to show, in display order. */
export function pageLinks(page) {
  return [websiteLink(page?.website), socialLink("instagram", page?.instagram), socialLink("facebook", page?.facebook)].filter(Boolean);
}

/** Check the "Look and feel" boxes. Returns { ok, errors, values } (empty boxes become ""). */
export function validateLook(form) {
  const text = (value) => String(value ?? "").trim();
  const values = {
    brandColor: text(form?.brandColor),
    thanks: text(form?.thanks).replace(/\s+/g, " "),
    website: text(form?.website),
    instagram: text(form?.instagram),
    facebook: text(form?.facebook),
  };
  const errors = {};
  if (values.brandColor && !normalizeHex(values.brandColor)) errors.brandColor = "Use a color code like #E8743B, or pick a circle.";
  if (values.thanks.length > THANKS_MAX) errors.thanks = `Keep this under ${THANKS_MAX} characters.`;
  if (values.website && !websiteLink(values.website)) errors.website = "That doesn't look like a website. Try something like yourrescue.org.";
  if (values.instagram && !socialLink("instagram", values.instagram)) errors.instagram = "Use your handle, like @yourrescue.";
  if (values.facebook && !socialLink("facebook", values.facebook)) errors.facebook = "Use your page link, like facebook.com/yourrescue.";
  if (values.brandColor) values.brandColor = normalizeHex(values.brandColor) ?? values.brandColor;
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Only https photo addresses are shown (logo and cover photo). */
export function safeImageUrl(input) {
  const raw = String(input ?? "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(raw) ? raw : "";
}
