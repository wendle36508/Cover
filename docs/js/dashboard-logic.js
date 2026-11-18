// dashboard-logic.js - the numbers and checks behind a nonprofit's dashboard.
// Pure functions only (no page, database or Stripe code), so each one is tested on its own.

export const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // what the storage bucket accepts
export const RAW_PHOTO_MAX_BYTES = 40 * 1024 * 1024; // what a phone photo can be before Cover shrinks it
export const PHOTO_LONG_SIDE = 1600; // photos are shrunk so their longest side is at most this
export const DEFAULT_FOCUS = { x: 50, y: 38 }; // a bit above center, where faces usually are

const cleanText = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

/** A page link from a name: "Harbor Paws Rescue!" -> "harbor-paws-rescue". */
export function slugify(name) {
  return cleanText(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop accents: cafe with an accent -> cafe
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** "Good morning", "Good afternoon" or "Good evening" for the hour of a date. */
export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Short status label and its style for a sponsor. */
export function statusLabel(status) {
  switch (status) {
    case "active":
      return { text: "Active", tone: "active" };
    case "past_due":
      return { text: "Card failed", tone: "late" };
    case "canceled":
      return { text: "Canceled", tone: "off" };
    default:
      return { text: "Waiting on payment", tone: "new" };
  }
}

/** The name a sponsor shows as in the dashboard (staff see real names, plus "business"). */
export function sponsorName(sponsor) {
  return sponsor.business_name || sponsor.first_name;
}

/**
 * Where a sponsor stands on the thank-you wall, for the owner's Sponsors table.
 * Only sponsors who ticked the box can be on it; the owner can hide or show them.
 * Returns { tone, text, button, hide } where button is "Hide", "Show" or null and hide is the next value to save.
 */
export function wallStatus(sponsor) {
  if (!sponsor?.show_name) return { tone: "off", text: "Private", button: null, hide: null };
  if (sponsor.wall_hidden) return { tone: "late", text: "Hidden by you", button: "Show", hide: false };
  return { tone: "active", text: "On the wall", button: "Hide", hide: true };
}

/** How the sponsor appears on the wall: the business name, or "Sarah K.". Matches the database. */
export function wallName(sponsor) {
  if (sponsor?.business_name) return sponsor.business_name;
  return sponsor?.last_initial ? `${sponsor.first_name} ${sponsor.last_initial}.` : sponsor?.first_name ?? "";
}

export const WELCOME_DAYS = 14; // how long a new sponsor shows in "Share a welcome"
export const WELCOME_MAX = 5;

/**
 * New sponsors the owner can post a welcome for: active, said yes to being thanked in public,
 * not hidden by the owner, following something, and joined in the last two weeks. Newest first.
 */
export function welcomeCandidates(sponsors, items, now = new Date()) {
  const names = new Map((items ?? []).map((item) => [item.id, item]));
  const cutoff = now.getTime() - WELCOME_DAYS * 86400000;
  return (sponsors ?? [])
    .filter((s) => s.status === "active" && s.show_name && !s.wall_hidden && names.has(s.item_id)
      && new Date(s.created_at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, WELCOME_MAX)
    .map((s) => ({ sponsor: s, item: names.get(s.item_id), greet: s.business_name || s.first_name }));
}

/** The big line on the welcome image: "Welcome Sarah, Bella's newest sponsor!" */
export function welcomeHeadline(greet, itemName) {
  return `Welcome ${greet}, ${itemName}'s newest sponsor!`;
}

/** The caption the owner copies to Instagram or Facebook, ending with their page link. */
export function welcomeCaption({ greet, itemName, nonprofitName, kind, link }) {
  const thanks = kind === "animal"
    ? `Thank you for helping ${itemName} (and every animal at ${nonprofitName}) get fed, walked and cared for each month.`
    : `Thank you for helping keep ${itemName} (and everything at ${nonprofitName}) going every month.`;
  const invite = kind === "animal" ? "Want to sponsor a buddy too?" : "Want to sponsor too?";
  return `${welcomeHeadline(greet, itemName)} ${thanks} ${invite} ${link}`;
}

/**
 * Break the headline into lines that fit the image. measure(text) returns a width; lines longer
 * than maxWidth wrap at spaces. Returns the lines (a single over-long word stays on its own line).
 */
export function wrapLines(text, maxWidth, measure) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A safe file name for the downloaded image: "welcome-sarah-bella.png". */
export function welcomeFileName(greet, itemName) {
  const part = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `welcome-${[part(greet), part(itemName)].filter(Boolean).join("-") || "sponsor"}.png`;
}

/** This month's numbers from the sponsor list. Money in whole dollars. */
export function monthStats(sponsors, goalCents, now = new Date()) {
  const active = sponsors.filter((s) => s.status === "active");
  const coveredCents = active.reduce((sum, s) => sum + (Number(s.monthly_cents) || 0), 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const newThisMonth = active.filter((s) => new Date(s.created_at) >= startOfMonth);
  const goal = Math.max(0, Math.round((Number(goalCents) || 0) / 100));
  const covered = Math.round(coveredCents / 100);
  const typicalGift = active.length ? coveredCents / active.length / 100 : 25;
  const remaining = Math.max(0, goal - covered);
  return {
    covered,
    goal,
    percent: goal > 0 ? Math.min(100, Math.round((covered / goal) * 100)) : 0,
    activeCount: active.length,
    newThisMonth: newThisMonth.length,
    businesses: active.filter((s) => s.business_name).length,
    businessesNew: newThisMonth.filter((s) => s.business_name).length,
    sponsorsToGoal: remaining > 0 ? Math.ceil(remaining / typicalGift) : 0,
    needsAttention: sponsors.filter((s) => s.status === "past_due").length,
  };
}

/** The newest sponsors, with what they follow, for the overview table. */
export function newestSponsors(sponsors, items, count = 5) {
  const names = new Map(items.map((item) => [item.id, item.name]));
  return [...sponsors]
    .filter((s) => s.status !== "canceled")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, count)
    .map((s) => ({ ...s, name: sponsorName(s), following: names.get(s.item_id) ?? "—", label: statusLabel(s.status) }));
}

/** Active things to follow, most sponsors first, with their counts. */
export function followedMost(items, sponsors) {
  const counts = new Map();
  for (const s of sponsors) if (s.status === "active" && s.item_id) counts.set(s.item_id, (counts.get(s.item_id) ?? 0) + 1);
  return items
    .filter((item) => item.status === "active")
    .map((item) => ({ ...item, sponsors: counts.get(item.id) ?? 0 }))
    .sort((a, b) => b.sponsors - a.sponsors || a.name.localeCompare(b.name));
}

/** Sponsor counts per item id (active sponsors only). */
export function countsByItem(sponsors) {
  const counts = new Map();
  for (const s of sponsors) if (s.status === "active" && s.item_id) counts.set(s.item_id, (counts.get(s.item_id) ?? 0) + 1);
  return counts;
}

/** The toast after "Mark adopted": how many sponsors were told. */
export function finishSummary(name, result) {
  const moved = result?.moved ?? 0;
  if (!moved) return `${name} marked finished.`;
  const people = (n) => `${n} sponsor${n === 1 ? "" : "s"}`;
  let text = `${name} marked finished.`;
  if (result.emailsOn === false) text += ` Emails aren't switched on yet, so ${people(moved)} weren't told.`;
  else if (result.queued) text += ` Cover has sent a lot of email today, so ${people(result.queued)} get the news tomorrow morning.`;
  else if (result.emailed) text += ` ${people(result.emailed)} got the news and can pick a new buddy.`;
  if (result.failed) text += ` ${result.failed} email${result.failed === 1 ? "" : "s"} didn't send.`;
  return text;
}

/** The "Get your page ready" list. linkShared is remembered in this browser. */
export function checklist({ nonprofit, items, linkShared }) {
  const activeItems = items.filter((item) => item.status === "active");
  const steps = [
    { key: "account", text: "Create your Cover account", done: true },
    { key: "stripe", text: "Set up payouts to get paid", done: Boolean(nonprofit.is_live), action: "connect" },
    { key: "items", text: `Add ${(nonprofit.page?.navLabel ?? "things").toLowerCase()} people can follow`, done: activeItems.length > 0, action: "items" },
    { key: "photos", text: "Upload real photos", done: activeItems.length > 0 && activeItems.every((item) => item.photo_url), action: "items" },
    { key: "share", text: "Share your page link", done: Boolean(linkShared), action: "share" },
  ];
  return { steps, done: steps.filter((step) => step.done).length };
}

/** Check the add/edit form for a thing to follow. Returns { ok, errors, values }. */
export function validateItem(form) {
  const values = { name: cleanText(form?.name), badge: cleanText(form?.badge), note: cleanText(form?.note) };
  const errors = {};
  if (!values.name) errors.name = "Add a name.";
  else if (values.name.length > 80) errors.name = "Keep the name under 80 characters.";
  if (values.badge.length > 40) errors.badge = "Keep this under 40 characters.";
  if (values.note.length > 200) errors.note = "Keep this under 200 characters.";
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Check a photo before Cover shrinks and uploads it. Returns an error message, or "" if it's fine. */
export function photoProblem(file) {
  if (!file) return "";
  if (typeof file.type !== "string" || !file.type.startsWith("image/")) return "That file isn't a photo.";
  if (file.size > RAW_PHOTO_MAX_BYTES) return "That photo is over 40 MB. Try a smaller one.";
  return "";
}

/** The size to shrink a photo to so its longest side fits, never enlarging. */
export function fitWithin(width, height, longSide = PHOTO_LONG_SIDE) {
  if (!(width > 0) || !(height > 0)) throw new Error("A photo needs a width and height.");
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A starting name from a file name: "bella_2.jpg" -> "Bella", camera names like IMG_1234 -> "". */
export function nameFromFile(fileName) {
  const base = String(fileName ?? "").replace(/\.[a-z0-9]+$/i, "");
  const words = base
    .replace(/[_\-.]+/g, " ")
    .replace(/\b(img|dsc|dscn|pxl|photo|image|screenshot|copy|edited|final)\b/gi, " ")
    .replace(/\d+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ").slice(0, 80);
}

/** Keep a crop point inside the photo (whole percents, 0 to 100). */
export function clampFocus(x, y) {
  const clean = (value, fallback) => (Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Math.round(Number(value)))) : fallback);
  return { x: clean(x, DEFAULT_FOCUS.x), y: clean(y, DEFAULT_FOCUS.y) };
}

/** The crop point for a click on a photo shown at width x height. */
export function focusFromClick(offsetX, offsetY, width, height) {
  if (!(width > 0) || !(height > 0)) return { ...DEFAULT_FOCUS };
  return clampFocus((offsetX / width) * 100, (offsetY / height) * 100);
}

/** CSS position that keeps the crop point in view, like "50% 38%". */
export function objectPosition(item) {
  const { x, y } = clampFocus(item?.photo_focus_x, item?.photo_focus_y);
  return `${x}% ${y}%`;
}

/** Where a photo is stored: the nonprofit's own folder plus a random name. */
export function photoPath(nonprofitId, file, randomId) {
  return `${nonprofitId}/${randomId}.${PHOTO_TYPES[file.type] ?? "jpg"}`;
}

/** Check the "Your page" form. Money is typed in dollars. Returns { ok, errors, values } (money in cents). */
export function validatePage(form) {
  const values = {
    name: cleanText(form?.name),
    headline: cleanText(form?.headline),
    lead: cleanText(form?.lead),
    navLabel: cleanText(form?.navLabel),
    everyone: cleanText(form?.everyone),
    priceCents: Math.round(Number(form?.price) * 100),
    goalCents: Math.round(Number(form?.goal) * 100),
  };
  const errors = {};
  if (values.name.length < 2 || values.name.length > 120) errors.name = "Use 2 to 120 characters.";
  if (values.headline.length > 90) errors.headline = "Keep the headline under 90 characters.";
  if (values.lead.length > 400) errors.lead = "Keep this under 400 characters.";
  if (values.navLabel.length < 2 || values.navLabel.length > 30) errors.navLabel = 'Use 2 to 30 characters, like "Dogs" or "Programs".';
  if (values.everyone.length > 80) errors.everyone = "Keep this under 80 characters.";
  if (!Number.isFinite(values.priceCents) || values.priceCents < 500 || values.priceCents > 100000) errors.price = "Pick $5 to $1,000 a month.";
  if (!Number.isFinite(values.goalCents) || values.goalCents < 100 || values.goalCents > 100000000) errors.goal = "Pick a goal from $1 to $1,000,000.";
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Check the "create your nonprofit" form. Returns { ok, errors, values } ready for create_my_nonprofit. */
export function validateSignup(form) {
  const values = {
    name: cleanText(form?.name),
    slug: cleanText(form?.slug).toLowerCase(),
    kind: form?.kind === "animal" ? "animal" : "program",
    followLabel: cleanText(form?.followLabel),
    priceCents: Math.round(Number(form?.price) * 100),
    goalCents: Math.round(Number(form?.goal) * 100),
  };
  const errors = {};
  if (values.name.length < 2 || values.name.length > 120) errors.name = "Use 2 to 120 characters.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.slug) || values.slug.length < 3 || values.slug.length > 60) {
    errors.slug = "Use lowercase letters, numbers and dashes (3 to 60).";
  }
  if (values.followLabel.length < 2 || values.followLabel.length > 30) errors.followLabel = 'Like "Dogs" or "Programs" (2 to 30 characters).';
  if (!Number.isFinite(values.priceCents) || values.priceCents < 500 || values.priceCents > 100000) errors.price = "Pick $5 to $1,000 a month.";
  if (!Number.isFinite(values.goalCents) || values.goalCents < 100 || values.goalCents > 100000000) errors.goal = "Pick a goal from $1 to $1,000,000.";
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** "2 hours ago"-style text for the dashboard tables. */
export function whenText(isoTime, now = new Date()) {
  const seconds = (now - new Date(isoTime)) / 1000;
  if (!(seconds >= 60)) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 172800) return "Yesterday";
  return new Date(isoTime).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How many sponsors an update about this one would reach: paying, following it, updates on. */
export function updateAudience(sponsors, itemId) {
  return sponsors.filter((s) => s.item_id === itemId && ["active", "past_due"].includes(s.status) && !s.updates_off).length;
}

/** The toast after "Send update": sent now (to how many), or scheduled for which morning. */
export function postSummary(name, result, now = new Date()) {
  if (!result?.sent) {
    const when = new Date(result?.scheduledFor ?? now);
    const day = when.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
    if (result?.deferred) return `Update saved. Cover has sent a lot of email today, so this one goes out ${day} morning.`;
    return `You already sent an update about ${name} today, so this one goes out ${day} at 9am.`;
  }
  if (result.emailsOn === false) return `Update saved. Emails aren't switched on yet, so no one was emailed.`;
  if (!result.sponsors) return `Update saved. ${name} has no sponsors with updates on yet, so no one was emailed.`;
  return `Update sent to ${result.emailed} sponsor${result.emailed === 1 ? "" : "s"}.`;
}
