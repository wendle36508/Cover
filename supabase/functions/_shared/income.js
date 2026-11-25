// income.js - the owner dashboard's income chart (Tanner, Nov 25, 2026: "a line chart of their income,
// more of a financial dashboard"). Plain JavaScript so Node can test it.
//
// It counts real money: payments that went through on the nonprofit's own Stripe account, minus any
// refunds, grouped by calendar month (Eastern time). Monthly and yearly sponsorships (paid through
// Stripe subscriptions) are kept apart from one-time gifts (which carry Cover's sponsor label).
// Failed or pending payments don't count. Nothing personal is returned: only totals per month.

export const INCOME_MONTHS = 12;
export const MAX_CHARGES = 2000; // plenty for a small nonprofit's year; the chart says so if it's ever cut short
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11" for a moment, in Eastern time. */
function monthKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
}

/** The last `count` months, oldest first: [{ key: "2025-12", label: "Dec" }, ... { key: "2026-11", label: "Nov" }]. */
export function recentMonths(now = new Date(), count = INCOME_MONTHS) {
  const [year, month] = monthKey(now).split("-").map(Number);
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = (year * 12 + (month - 1)) - back;
    const y = Math.floor(index / 12);
    const m = index % 12;
    months.push({ key: `${y}-${String(m + 1).padStart(2, "0")}`, label: MONTH_LABELS[m], year: y });
  }
  return months;
}

/** The earliest moment a chart of `count` months needs (start of the oldest month, a day early to be safe), in Unix seconds. */
export function incomeSince(now = new Date(), count = INCOME_MONTHS) {
  const [oldest] = recentMonths(now, count);
  return Math.floor(Date.UTC(Number(oldest.key.slice(0, 4)), Number(oldest.key.slice(5)) - 1, 1) / 1000) - 86400;
}

/** A one-time gift through Cover's checkout (its payment carries Cover's sponsor label); everything else is a sponsorship payment. */
function isOneTime(charge) {
  return typeof charge?.metadata?.cover_sponsor_id === "string" && charge.metadata.cover_sponsor_id.length > 0;
}

/**
 * Stripe charges -> one row per month, oldest first:
 * [{ key, label, year, sponsorCents, oneTimeCents, totalCents }], plus the 12-month totals.
 */
export function incomeByMonth(charges, now = new Date(), count = INCOME_MONTHS) {
  const months = recentMonths(now, count).map((m) => ({ ...m, sponsorCents: 0, oneTimeCents: 0, totalCents: 0 }));
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const charge of charges ?? []) {
    if (!charge || charge.status !== "succeeded" || charge.paid !== true) continue;
    const net = Math.max(0, (Number(charge.amount) || 0) - (Number(charge.amount_refunded) || 0));
    if (!net) continue;
    const row = byKey.get(monthKey(new Date(Number(charge.created) * 1000)));
    if (!row) continue;
    if (isOneTime(charge)) row.oneTimeCents += net;
    else row.sponsorCents += net;
    row.totalCents += net;
  }
  const totalCents = months.reduce((sum, m) => sum + m.totalCents, 0);
  return { months, totalCents, thisMonthCents: months[months.length - 1].totalCents };
}
