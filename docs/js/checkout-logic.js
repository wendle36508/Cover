// checkout-logic.js - the rules behind the new checkout (phase 3), kept apart so Node can test them:
// how often, how much (any amount from $5), what the button says, and the gift's arrival day.
// The server checks the same limits again (supabase/functions/_shared/sponsorship.js, INTERVALS).

export const MIN_GIFT_CENTS = 500;
export const FREQUENCIES = [
  { key: "month", label: "Monthly", per: "a month", maxCents: 100000 },
  { key: "year", label: "Yearly", per: "a year", maxCents: 1200000 },
  { key: "once", label: "One time", per: "one time", maxCents: 1000000 },
];

export const frequency = (key) => FREQUENCIES.find((f) => f.key === key) ?? FREQUENCIES[0];

/** "$25", "$25.50", "$1,000". */
export function dollars(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** What the donor typed, as cents: { cents } or { error } with a plain message. */
export function readAmount(text, key = "month") {
  const clean = String(text ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(clean)) return { error: "Type an amount, like 25." };
  const cents = Math.round(Number(clean) * 100);
  const f = frequency(key);
  if (cents < MIN_GIFT_CENTS) return { error: "The smallest gift is $5." };
  if (cents > f.maxCents) return { error: `The largest gift here is ${dollars(f.maxCents)} ${f.per}.` };
  return { cents };
}

/** The pay button: "Continue to $18 a month", "Continue to $200 a year", "Continue to give $50". */
export function buttonText(cents, key = "month") {
  if (!(cents > 0)) return "Continue";
  return key === "once" ? `Continue to give ${dollars(cents)}` : `Continue to ${dollars(cents)} ${frequency(key).per}`;
}

/** Today's date where the donor is, as YYYY-MM-DD (the earliest a gift can arrive). */
export function todayIso(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** The latest a gift can be scheduled: a year from today. */
export function latestGiftDay(now = new Date()) {
  return todayIso(new Date(now.getTime() + 365 * 86400000));
}

// Phase 4 turns these on: the photo certificate, and gifts reaching the person they're for.
export const CERTIFICATE_READY = true;
export const GIFTS_READY = true;

/** What one-time givers get, and what ongoing sponsors get (shown under the amount box). */
export function frequencyNote(key, itemName, certificateReady = CERTIFICATE_READY) {
  if (key === "once") return certificateReady ? `You'll get a thank-you and ${itemName}'s photo certificate.` : "You'll get a thank-you and a receipt.";
  return "Any amount from $5. You can change it or cancel anytime.";
}
