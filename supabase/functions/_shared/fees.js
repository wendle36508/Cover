// fees.js - Cover's fee after the pilot (Tanner, Nov 22, 2026): Cover keeps 3% of each gift, taken
// by Stripe as an "application fee" on the nonprofit's own account. It's off for every nonprofit
// until a Cover admin switches it on in HQ (nonprofits.cover_fee_on). Donors see it before paying
// and can tick a box to add enough that the nonprofit still gets their full gift.
// A copy of these few functions lives in docs/js/fees.js for the sponsor page; a test keeps them the same.

export const COVER_FEE_PERCENT = 3;

/** Cents shown as "$25", "$25.78" or "$0.78". */
export function formatCents(cents) {
  const dollars = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * What to charge so the nonprofit still gets the whole gift after Cover's fee:
 * the smallest total where total minus the fee is at least the gift ($25 -> $25.78).
 */
export function coveredTotalCents(giftCents, percent = COVER_FEE_PERCENT) {
  const gift = Math.max(0, Math.round(Number(giftCents) || 0));
  if (!(percent > 0)) return gift;
  return Math.ceil((gift * 100) / (100 - percent));
}

/** The gift inside a covered total (the reverse of coveredTotalCents): $25.78 -> $25. */
export function giftFromCoveredTotal(totalCents, percent = COVER_FEE_PERCENT) {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  if (!(percent > 0)) return total;
  return Math.floor((total * (100 - percent)) / 100);
}

/**
 * What one gift charges. feeOn comes from the nonprofit's switch; coverFee is the donor's box.
 * With the fee off, nothing changes: no fee, and the box is ignored even if someone sends it.
 * Returns { chargedCents, feePercent, coversFee }.
 */
export function chargePlan({ giftCents, feeOn, coverFee }) {
  const gift = Math.max(0, Math.round(Number(giftCents) || 0));
  if (feeOn !== true) return { chargedCents: gift, feePercent: 0, coversFee: false };
  const covers = coverFee === true;
  return { chargedCents: covers ? coveredTotalCents(gift) : gift, feePercent: COVER_FEE_PERCENT, coversFee: covers };
}
