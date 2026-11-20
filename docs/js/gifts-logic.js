// gifts-logic.js - the parts of the "My gifts" page that don't touch the page itself (formatting,
// labels, checks and the demo), so Node can test them. Used by gifts.js.

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
    gifts: [
      {
        id: "demo-1", status: "active", canChange: true, startedAt: new Date(now - 95 * day).toISOString(), monthlyCents: 2500,
        updatesOff: false, onWall: true,
        nonprofit: { name: "Harbor Paws Rescue", slug: "harbor-paws", kind: "animal", logo: null, brandColor: null },
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
        id: "demo-2", status: "past_due", canChange: true, startedAt: new Date(now - 40 * day).toISOString(), monthlyCents: 1500,
        updatesOff: true, onWall: false,
        nonprofit: { name: "Eastside Community Pantry", slug: "pantry", kind: "program", logo: null, brandColor: null },
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
