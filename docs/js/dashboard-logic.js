// dashboard-logic.js - the numbers and checks behind a nonprofit's dashboard.
// Pure functions only (no page, database or Stripe code), so each one is tested on its own.

export const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const cleanText = (value) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

/** A page link from a name: "Harbor Paws Rescue!" -> "harbor-paws-rescue". */
export function slugify(name) {
  return cleanText(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
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

/** Check a photo before uploading. Returns an error message, or "" if it's fine. */
export function photoProblem(file) {
  if (!file) return "";
  if (!PHOTO_TYPES[file.type]) return "Use a JPG, PNG or WebP photo.";
  if (file.size > PHOTO_MAX_BYTES) return "That photo is over 5 MB. Try a smaller one.";
  return "";
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
