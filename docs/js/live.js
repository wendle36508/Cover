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

async function get(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!response.ok) throw new Error(`Couldn't load ${path.split("?")[0]} (${response.status}).`);
  return response.json();
}

async function rpc(name, args) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`Couldn't load ${name} (${response.status}).`);
  return response.json();
}

/**
 * Turn database rows into the shape give.js draws. Pure, so it can be tested.
 * counts: [{ item_id, sponsors }], coveredCents: number, recent: [{ display_name, item_name, joined_at }]
 */
export function orgFromRows(nonprofit, items, counts = [], coveredCents = 0, recent = []) {
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
    goal: Math.round(nonprofit.monthly_goal_cents / 100),
    covered: Math.round(Number(coveredCents) / 100),
    headline: page.headline ?? `Sponsor ${nonprofit.name} for $${price} a month.`,
    lead: page.lead ?? `Your monthly gift keeps ${nonprofit.name} running.`,
    trust: page.trust ?? "Cancel anytime.",
    recent,
    // The nonprofit's own cover photo, if they uploaded one (otherwise the first photo is used).
    heroPhotoWide: safeImageUrl(page.coverPhoto) || undefined,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      photo: item.photo_url ?? "",
      focus: `${item.photo_focus_x ?? 50}% ${item.photo_focus_y ?? 38}%`,
      badge: item.badge ?? "",
      note: item.note ?? "",
      hot: false,
      sponsors: countFor.get(item.id) ?? 0,
    })),
  };
}

/** The live page for a nonprofit, or null if it isn't in the database (or isn't live yet). */
export async function loadLiveOrg(slug) {
  if (!SLUG_PATTERN.test(slug ?? "")) return null;
  const [nonprofit] = await get(
    `nonprofits?slug=eq.${slug}&select=id,slug,name,place,kind,monthly_price_cents,monthly_goal_cents,page`,
  );
  if (!nonprofit) return null;
  const [items, counts, covered, recent] = await Promise.all([
    get(`follow_items?nonprofit_id=eq.${nonprofit.id}&status=eq.active&select=id,name,photo_url,photo_focus_x,photo_focus_y,badge,note&order=sort_order,created_at`),
    rpc("page_item_counts", { target: nonprofit.id }),
    rpc("page_monthly_covered", { target: nonprofit.id }),
    rpc("page_recent_sponsors", { target: nonprofit.id, how_many: 1 }),
  ]);
  return orgFromRows(nonprofit, items, counts, covered, recent);
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
