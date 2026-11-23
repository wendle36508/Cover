// live.js - loads a real nonprofit's sponsor page from Cover's database, and starts payments.
// Only reads what the database's safety rules allow visitors to read (live pages, counts,
// display names). If the page isn't in the database, give.js falls back to the demo pages.

import { safeImageUrl } from "./brand.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const HEADERS = { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` };
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Page text a nonprofit can leave out; the page falls back to these. */
const DEFAULT_PAGE = {
  eyebrow: "Monthly sponsorship",
  navLabel: "Sponsor",
  cta: "Become a sponsor",
  browse: "See who you can sponsor",
  listEyebrow: "Ways to sponsor",
  listTitle: "Pick something to follow.",
  listLead: "Whichever you pick, your gift goes into one fund that helps everyone here.",
  filters: [],
  steps: [
    ["Pick one to follow", "Every gift goes into one fund for the whole organization."],
    ["Give monthly", "Pay securely right here. Cancel anytime."],
    ["Get the updates", "News and photos from what you picked."],
  ],
  faq: [],
  everyone: "everyone here",
  quote: ["Your gift helps everyone here. What you follow just keeps you ", "in the loop."],
};

// Where the dashboard's sign-in is saved in this browser (Supabase's default name for it).
const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

/**
 * The signed-in person's access token from the saved sign-in, or null if there isn't a usable one.
 * Lets a nonprofit's staff see their own page before it's live (the database only shows hidden
 * pages to their staff). Everyone else reads the page as a visitor. Pure, so it can be tested.
 */
export function savedAccessToken(raw, nowMs = Date.now()) {
  try {
    const session = JSON.parse(raw ?? "null");
    const token = session?.access_token;
    const expiresMs = Number(session?.expires_at) * 1000;
    return typeof token === "string" && token.split(".").length === 3 && expiresMs > nowMs + 30_000 ? token : null;
  } catch {
    return null;
  }
}

function signedInHeaders() {
  let raw = null;
  try {
    raw = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY) ?? null;
  } catch {
    // storage blocked (private window): read as a visitor
  }
  const token = savedAccessToken(raw);
  return token ? { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` } : null;
}

/** Read from the database, as the signed-in person if there is one; a refused sign-in falls back to visitor. */
async function read(url, init, what) {
  const asUser = signedInHeaders();
  let response = await fetch(url, { ...init, headers: { ...(asUser ?? HEADERS), ...init.headers } });
  if (asUser && response.status === 401) response = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers } });
  if (!response.ok) throw new Error(`Couldn't load ${what} (${response.status}).`);
  return response.json();
}

function get(path) {
  return read(`${SUPABASE_URL}/rest/v1/${path}`, { headers: {} }, path.split("?")[0]);
}

function rpc(name, args) {
  return read(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }, name);
}

/**
 * Turn database rows into the shape give.js draws. Pure, so it can be tested.
 * counts: [{ item_id, sponsors }], coveredCents: number, recent: [{ display_name, item_name, joined_at }],
 * wall: [{ display_name, joined_at }] (the thank-you wall, newest first; names only)
 */
export function orgFromRows(nonprofit, items, counts = [], coveredCents = 0, recent = [], wall = []) {
  const page = { ...DEFAULT_PAGE, ...(nonprofit.page ?? {}) };
  const countFor = new Map(counts.map((row) => [row.item_id, Number(row.sponsors) || 0]));
  const price = Math.round(nonprofit.monthly_price_cents / 100);
  const initials = nonprofit.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("");
  return {
    ...page,
    live: true,
    id: nonprofit.id,
    slug: nonprofit.slug,
    name: nonprofit.name,
    place: nonprofit.place ?? "",
    kind: nonprofit.kind,
    initials: page.initials ?? initials,
    price,
    priceCents: nonprofit.monthly_price_cents,
    feeOn: nonprofit.cover_fee_on === true, // Cover's 3% fee (off for everyone during the pilot)
    goal: Math.round(nonprofit.monthly_goal_cents / 100),
    covered: Math.round(Number(coveredCents) / 100),
    headline: page.headline ?? `Sponsor ${nonprofit.name} for $${price} a month.`,
    lead: page.lead ?? `Your monthly gift keeps ${nonprofit.name} running.`,
    trust: page.trust ?? "Cancel anytime.",
    recent,
    wall: wall.map((row) => row.display_name).filter((name) => typeof name === "string" && name.trim()),
    // The nonprofit's own cover photo, if they uploaded one (otherwise the first photo is used).
    heroPhotoWide: safeImageUrl(page.coverPhoto) || undefined,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      photo: item.photo_url ?? "",
      focus: `${item.photo_focus_x ?? 50}% ${item.photo_focus_y ?? 38}%`,
      badge: item.badge ?? "",
      note: item.note ?? "",
      story: item.story ?? "",
      // New sponsor pages (phase 1): facts as chips, groups, and the profile's extra lines.
      facts: item.facts && typeof item.facts === "object" && !Array.isArray(item.facts) ? item.facts : {},
      isGroup: item.is_group === true,
      why: item.why ?? "",
      loves: item.loves ?? "",
      dislikes: item.dislikes ?? "",
      addedAt: item.created_at ?? null,
      morePhotos: (Array.isArray(item.more_photos) ? item.more_photos : []).map(safeImageUrl).filter(Boolean).slice(0, 6),
      hot: false,
      sponsors: countFor.get(item.id) ?? 0,
    })),
  };
}

/** The live page for a nonprofit, or null if it isn't in the database (or isn't live yet). */
export async function loadLiveOrg(slug) {
  if (!SLUG_PATTERN.test(slug ?? "")) return null;
  const [nonprofit] = await get(
    `nonprofits?slug=eq.${slug}&select=id,slug,name,place,kind,monthly_price_cents,monthly_goal_cents,page,cover_fee_on`,
  );
  if (!nonprofit) return null;
  const [items, counts, covered, recent, wall] = await Promise.all([
    get(`follow_items?nonprofit_id=eq.${nonprofit.id}&status=eq.active&select=id,name,photo_url,photo_focus_x,photo_focus_y,badge,note,story,more_photos,facts,is_group,why,loves,dislikes,created_at&order=sort_order,created_at`),
    rpc("page_item_counts", { target: nonprofit.id }),
    rpc("page_monthly_covered", { target: nonprofit.id }),
    rpc("page_recent_sponsors", { target: nonprofit.id, how_many: 1 }),
    rpc("page_thank_you_wall", { target: nonprofit.id, how_many: 200 }),
  ]);
  return orgFromRows(nonprofit, items, counts, covered, recent, wall);
}

/** Ask Cover's server for Stripe's card form. Returns { clientSecret, stripeAccount } or throws with a friendly message. */
export async function startSponsorship(signup) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/create-sponsorship`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(signup),
    });
  } catch {
    throw new Error("We couldn't reach the payment server. Check your connection and try again.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.clientSecret) throw new Error(body.error ?? "Something went wrong. Please try again.");
  return body;
}
