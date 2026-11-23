// fees.js - the sponsor page's copy of Cover's fee math (the server's is supabase/functions/_shared/fees.js,
// and the server decides what's actually charged). Cover keeps 3% of each gift once a Cover admin
// switches it on for a nonprofit; until then the page shows no fee line and charges exactly as before.
// tests/fees.test.js checks this copy gives the same answers as the server's.

export const COVER_FEE_PERCENT = 3;

/** Cents shown as "$25", "$25.78" or "$0.78". */
export function formatCents(cents) {
  const dollars = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** What to charge so the nonprofit still gets the whole gift after Cover's fee ($25 -> $25.78). */
export function coveredTotalCents(giftCents, percent = COVER_FEE_PERCENT) {
  const gift = Math.max(0, Math.round(Number(giftCents) || 0));
  if (!(percent > 0)) return gift;
  return Math.ceil((gift * 100) / (100 - percent));
}
