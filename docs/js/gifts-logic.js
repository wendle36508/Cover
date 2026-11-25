// gifts-logic.js - the parts of the "My sponsorships" page (gifts.html) that don't touch the page itself
// (formatting, labels, checks and the demo), so Node can test them. Used by gifts.js.

export const TOKEN_KEY = "cover-gifts-token"; // kept for this browser tab only (sessionStorage)

/** $25 or $25.50 */
export function money(cents) {
  const dollars = (Number(cents) || 0) / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "Dec 3, 2026" (or "" for a missing date) */
export function shortDate(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "November 2026" */
export function monthYear(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** The status pill: label and style. */
export function statusInfo(status) {
  if (status === "active") return { label: "Active", tone: "green" };
  if (status === "past_due") return { label: "Card didn't go through", tone: "warn" };
  if (status === "pending") return { label: "Starting", tone: "" };
  return { label: "Ended", tone: "" };
}

/** "You follow Bella" or "You support everyone at Harbor Paws" (past tense once the gift has ended). */
export function followLine(gift) {
  const ended = !gift.canChange;
  if (gift.following) return `${ended ? "You followed" : "You follow"} ${gift.following.name}`;
  return `${ended ? "You supported" : "You support"} everyone at ${gift.nonprofit.name}`;
}

/** The line under it: what the gift does (or did). */
export function helpsLine(gift) {
  const who = gift.nonprofit.kind === "animal" ? "every animal" : "everything";
  return gift.canChange ? `Your gift helps ${who} at ${gift.nonprofit.name}.` : `Your gifts helped ${who} at ${gift.nonprofit.name}. Thank you.`;
}

/** "$25 a month" or "$300 a year" (the gift they chose, without any fee they added on top). */
export function amountLabel(gift) {
  return `${money(gift.giftCents ?? gift.monthlyCents)} a ${gift.interval === "year" ? "year" : "month"}`;
}

/** Who a gift is about: the one they follow, or the whole nonprofit. */
export function giftName(gift) {
  return gift.following?.name ?? gift.nonprofit.name;
}

/** How long a sponsorship has been going: "1 week", "3 weeks", "2 months", "1 year". Same rule as the update emails. */
export function togetherLabel(startIso, now = new Date()) {
  const start = new Date(startIso ?? "");
  if (!startIso || Number.isNaN(start.getTime())) return "";
  const days = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
  if (days < 30) {
    const weeks = Math.max(1, Math.floor(days / 7));
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  const months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth()
    - (now.getUTCDate() < start.getUTCDate() ? 1 : 0);
  if (months < 12) {
    const shown = Math.max(1, months);
    return `${shown} ${shown === 1 ? "month" : "months"}`;
  }
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

/**
 * The line under "Hi Sarah": "You sponsor 2 dogs at Lucky Pup Rescue, $35 a month in all. Thank you."
 * Counts only gifts that are still going. The total shows only when every one is monthly.
 */
export function summaryLine(gifts) {
  const going = (gifts ?? []).filter((g) => g.canChange);
  if (!going.length) return "Thank you for everything you've given.";
  const orgs = [...new Set(going.map((g) => g.nonprofit.name))];
  const ones = [...new Set(going.map((g) => (g.following ? g.nonprofit.one || "" : "")))];
  const where = ` at ${orgs.length === 1 ? orgs[0] : `${orgs.length} nonprofits`}`;
  const total = going.every((g) => g.interval !== "year")
    ? `, ${money(going.reduce((sum, g) => sum + (g.giftCents ?? g.monthlyCents ?? 0), 0))} a month${going.length > 1 ? " in all" : ""}`
    : "";
  if (going.length === 1) {
    const only = going[0];
    return only.following ? `You sponsor ${only.following.name}${where}${total}. Thank you.` : `You sponsor ${orgs[0]}${total}. Thank you.`;
  }
  // "2 dogs" when they all follow the same kind of one; otherwise "2 sponsorships".
  if (ones.length === 1 && ones[0]) return `You sponsor ${going.length} ${ones[0]}s${where}${total}. Thank you.`;
  return `You have ${going.length} sponsorships${where}${total}. Thank you.`;
}

/** Every update across their gifts, newest first: [{ date, text, photoUrl, name, org }]. */
export function updatesFeed(gifts, max = 20) {
  return (gifts ?? [])
    .flatMap((g) => (g.updates ?? []).map((u) => ({ ...u, name: giftName(g), org: g.nonprofit.name, fallbackPhoto: g.following?.photoUrl ?? null })))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, max);
}

/** Every payment across their gifts, newest first, with who it was for. */
export function paymentsFeed(gifts, max = 24) {
  return (gifts ?? [])
    .flatMap((g) => (g.payments ?? []).map((p) => ({ ...p, name: giftName(g) })))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, max);
}

/** Dollars typed in the amount box, checked the same way Cover's server checks them. Returns cents or an error. */
export function readDollars(value) {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return { error: "Type an amount in dollars, like 25." };
  const cents = Math.round(Number(text) * 100);
  if (cents < 500) return { error: "The smallest monthly gift is $5." };
  if (cents > 100000) return { error: "The largest monthly gift here is $1,000." };
  return { cents };
}

/** Where the "My gifts" token comes from: the link (then hidden from the address bar) or this tab's memory. */
export function pickToken(search, stored) {
  const fromLink = new URLSearchParams(search).get("t");
  return { token: fromLink || stored || "", fromLink: Boolean(fromLink) };
}

/** Sample gifts for the demo (gifts.html?demo=1): nothing real is read or changed. */
export function demoGifts() {
  const now = Date.now();
  const day = 86400000;
  const paid = (daysAgo, cents = 2500) => ({ date: new Date(now - daysAgo * day).toISOString(), amountCents: cents, status: "Paid", paid: true, receiptUrl: "#receipt" });
  return {
    email: "sarah@example.com",
    firstName: "Sarah",
    gifts: [
      {
        id: "demo-1", status: "active", canChange: true, startedAt: new Date(now - 95 * day).toISOString(), monthlyCents: 2500, giftCents: 2500,
        interval: "month", holderName: "Sarah K.", certificateUrl: "#demo-certificate", updatesOff: false, onWall: true,
        updates: [
          { date: new Date(now - 3 * day).toISOString(), text: "Bella learned to wait for her dinner this week. Her whole tail stopped wagging. Almost.", photoUrl: null },
          { date: new Date(now - 33 * day).toISOString(), text: "Bella's first trip to the beach. She wasn't sure about the waves.", photoUrl: null },
        ],
        nonprofit: { name: "Harbor Paws Rescue", slug: "harbor-paws", kind: "animal", one: "dog", logo: null, brandColor: null },
        following: { id: "bella", name: "Bella", photoUrl: "photos/dog-smile.jpg" },
        choices: [
          { id: "bella", name: "Bella", photoUrl: "photos/dog-smile.jpg" },
          { id: "moose", name: "Moose", photoUrl: "photos/dog-brindle.jpg" },
          { id: "pepper", name: "Pepper", photoUrl: "photos/dog-puppy.jpg" },
        ],
        card: { label: "Visa ending 4242", expires: "4/28" },
        nextCharge: new Date(now + 12 * day).toISOString(),
        payments: [paid(18), paid(48), paid(78)],
        stripeReached: true,
      },
      {
        id: "demo-2", status: "past_due", canChange: true, startedAt: new Date(now - 40 * day).toISOString(), monthlyCents: 1500, giftCents: 1500,
        interval: "month", holderName: "Sarah K.", certificateUrl: "#demo-certificate", updatesOff: true, onWall: false,
        updates: [{ date: new Date(now - 10 * day).toISOString(), text: "The produce table fed 64 families on Saturday.", photoUrl: null }],
        nonprofit: { name: "Eastside Community Pantry", slug: "pantry", kind: "program", one: "program", logo: null, brandColor: null },
        following: { id: "produce", name: "Fresh Produce Table", photoUrl: "photos/pantry-fruit.jpg" },
        choices: [
          { id: "produce", name: "Fresh Produce Table", photoUrl: "photos/pantry-fruit.jpg" },
          { id: "family", name: "Tuesday Family Night", photoUrl: "photos/pantry-basket.jpg" },
        ],
        card: { label: "Mastercard ending 0005", expires: "10/26" },
        nextCharge: new Date(now + 3 * day).toISOString(),
        payments: [
          { date: new Date(now - 4 * day).toISOString(), amountCents: 1500, status: "Didn't go through", paid: false, receiptUrl: null },
          paid(34, 1500),
        ],
        stripeReached: true,
      },
    ],
  };
}
