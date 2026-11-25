// portal.js - the logic behind a sponsor's "My gifts" page (covergiving.com/gifts.html), in plain
// JavaScript so Node can test it. The sponsor-portal server function does the database and Stripe calls.
//
// What a sponsor can do there, for each gift tied to their email:
//   * see it: who they follow, the amount, the card on file, the next charge, and past payments with receipts
//   * update their card (Stripe's own secure card form on the nonprofit's account)
//   * change the monthly amount (from the next charge on; nothing is charged right away)
//   * follow someone else at the same nonprofit, turn updates or the thank-you wall on or off
//   * cancel: no more charges from now on (nothing already paid is refunded)

// Same limits as a nonprofit's own gift amount (see the nonprofits table).
import { coveredTotalCents, giftFromCoveredTotal } from "./fees.js";
import { pageBasics } from "./pack.js";

export const MIN_MONTHLY_CENTS = 500;
export const MAX_MONTHLY_CENTS = 100000;
export const MAX_YEARLY_CENTS = 1200000; // $12,000 a year (same as the new checkout)
export const PAYMENTS_SHOWN = 12;

export class BadInput extends Error {}

/** Dollars typed by a sponsor ("30", "30.50", 30) as whole cents, within Cover's limits. */
export function readAmountCents(value, interval = "month") {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) throw new BadInput("Type an amount in dollars, like 25.");
  const cents = Math.round(Number(text) * 100);
  const yearly = interval === "year";
  const max = yearly ? MAX_YEARLY_CENTS : MAX_MONTHLY_CENTS;
  const word = yearly ? "yearly" : "monthly";
  if (cents < MIN_MONTHLY_CENTS) throw new BadInput(`The smallest ${word} gift is $${MIN_MONTHLY_CENTS / 100}.`);
  if (cents > max) throw new BadInput(`The largest ${word} gift here is $${(max / 100).toLocaleString("en-US")}.`);
  return cents;
}

/** How often a subscription charges ("month" or "year"), from its price. */
export function subscriptionInterval(subscription) {
  return giftItem(subscription)?.price?.recurring?.interval === "year" ? "year" : "month";
}

/** Gifts worth showing: anything Stripe set up. A "pending" row with no subscription is a card form someone closed. */
export function visibleSponsorships(rows) {
  return (rows ?? []).filter((row) => row.stripe_subscription_id && ["active", "past_due", "canceled", "pending"].includes(row.status));
}

/** Gifts that can still be changed (not canceled). */
export function canChange(status) {
  return status === "active" || status === "past_due" || status === "pending";
}

/** The id inside a Stripe field that may be an id or an expanded object. */
function idOf(value) {
  return typeof value === "string" ? value : value?.id ?? null;
}

/** The subscription's first (only) item: Cover's gifts have one line. */
export function giftItem(subscription) {
  return subscription?.items?.data?.[0] ?? null;
}

/** When the next charge happens (ISO date), or null when nothing more will be charged. */
export function nextChargeDate(subscription) {
  if (!subscription || ["canceled", "incomplete_expired"].includes(subscription.status) || subscription.cancel_at_period_end) return null;
  const end = giftItem(subscription)?.current_period_end ?? subscription.current_period_end; // newer API keeps it on the item
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

/** "Visa ending 4242 (exp 4/28)", or a short name for other ways to pay, from the subscription's payment method. */
export function cardSummary(subscription) {
  const method = subscription?.default_payment_method;
  if (!method || typeof method === "string") return null;
  if (method.type === "card" && method.card) {
    const brand = String(method.card.brand ?? "card").replace(/^\w/, (c) => c.toUpperCase()).replace("Amex", "American Express");
    return { label: `${brand} ending ${method.card.last4}`, expires: `${method.card.exp_month}/${String(method.card.exp_year).slice(-2)}` };
  }
  if (method.type === "link") return { label: "Link", expires: null };
  return { label: String(method.type ?? "Saved payment").replace(/_/g, " "), expires: null };
}

const INVOICE_STATUS = { paid: "Paid", open: "Didn't go through", uncollectible: "Didn't go through", void: "Canceled" };

/** Past payments for the page: newest first, only real charges (no $0 lines, no drafts). */
export function paymentRows(invoices) {
  return (invoices ?? [])
    .filter((invoice) => invoice && invoice.status !== "draft" && (invoice.amount_due ?? 0) > 0)
    .map((invoice) => {
      const paidAt = invoice.status_transitions?.paid_at;
      return {
        date: new Date(((invoice.status === "paid" && paidAt) || invoice.created) * 1000).toISOString(),
        amountCents: invoice.status === "paid" ? invoice.amount_paid : invoice.amount_due,
        status: INVOICE_STATUS[invoice.status] ?? "Waiting",
        paid: invoice.status === "paid",
        receiptUrl: /^https:\/\//.test(invoice.hosted_invoice_url ?? "") ? invoice.hosted_invoice_url : null,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, PAYMENTS_SHOWN);
}

/** Stripe's update for a new monthly amount: same product, new price, starting with the next charge. */
export function amountChange(subscription, cents) {
  const item = giftItem(subscription);
  const product = idOf(item?.price?.product);
  if (!item?.id || !product) throw new BadInput("This gift can't be changed here. Email hello@covergiving.com and we'll help.");
  return {
    // Same product and the same how-often (a yearly gift stays yearly); only the amount changes.
    items: [{ id: item.id, price_data: { currency: "usd", product, unit_amount: cents, recurring: { interval: subscriptionInterval(subscription) } } }],
    proration_behavior: "none",
  };
}

/** The settings for Stripe's card-update screen on a nonprofit's account (created once, then reused). */
export function portalConfiguration(siteUrl) {
  return {
    business_profile: { privacy_policy_url: `${siteUrl}/privacy.html`, terms_of_service_url: `${siteUrl}/terms.html` },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: false },
      subscription_cancel: { enabled: false }, // canceling happens on Cover's page, so Cover's records stay right
    },
  };
}

/** A Stripe session that opens straight on "update your card" and comes back to the My gifts page. */
export function cardSession(customerId, configurationId, returnUrl) {
  return {
    customer: customerId,
    configuration: configurationId,
    return_url: returnUrl,
    flow_data: {
      type: "payment_method_update",
      after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
    },
  };
}

/** One gift as the page shows it. stripe = { subscription, invoices } or null when Stripe couldn't be reached. */
/**
 * What a new monthly gift charges. A donor who chose to cover Cover's fee keeps covering it:
 * they type the gift ($30) and are charged enough that the nonprofit still gets all of it ($30.93).
 */
export function chargeForGift(giftCents, sponsor) {
  const percent = Number(sponsor?.fee_percent) || 0;
  return sponsor?.covers_fee === true && percent > 0 ? coveredTotalCents(giftCents, percent) : giftCents;
}

/** How the sponsor's name reads on their certificate: the person a gift is for, a business, "Sarah K." or "Sarah". */
export function holderName(sponsor) {
  if (sponsor?.gift_name) return sponsor.gift_name;
  if (sponsor?.business_name) return sponsor.business_name;
  return sponsor?.last_initial ? `${sponsor.first_name} ${sponsor.last_initial}.` : sponsor?.first_name ?? "";
}

const httpsOnly = (url) => (typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);

/**
 * One gift as the My sponsorships page shows it. certificateUrl and updates (the owner's updates about who
 * they follow, newest first: [{ sent_at, body, photo_url }]) come from the server; nothing else private.
 */
export function giftView({ sponsor, nonprofit, item, choices, stripe, certificateUrl = /** @type {string | null} */ (null), updates = /** @type {any[]} */ ([]) }) {
  const page = nonprofit?.page ?? {};
  const subscription = stripe?.subscription ?? null;
  const priceCents = giftItem(subscription)?.price?.unit_amount;
  return {
    id: sponsor.id,
    status: sponsor.status,
    canChange: canChange(sponsor.status),
    startedAt: sponsor.created_at,
    monthlyCents: typeof priceCents === "number" ? priceCents : sponsor.monthly_cents,
    // When the donor covers Cover's fee: the gift they chose, and the extra on top of it.
    coversFee: sponsor.covers_fee === true && Number(sponsor.fee_percent) > 0,
    giftCents: sponsor.covers_fee === true && Number(sponsor.fee_percent) > 0
      ? giftFromCoveredTotal(typeof priceCents === "number" ? priceCents : sponsor.monthly_cents, Number(sponsor.fee_percent))
      : (typeof priceCents === "number" ? priceCents : sponsor.monthly_cents),
    updatesOff: sponsor.updates_off,
    onWall: sponsor.show_name,
    nonprofit: {
      name: nonprofit?.name ?? "",
      slug: nonprofit?.slug ?? "",
      kind: nonprofit?.kind ?? "program",
      one: pageBasics(page, nonprofit?.kind).one, // what they call the ones you follow: "dog"
      logo: page.logo ?? null,
      brandColor: page.brandColor ?? null,
    },
    interval: sponsor.interval === "year" ? "year" : "month",
    holderName: holderName(sponsor),
    certificateUrl,
    updates: (updates ?? []).map((u) => ({ date: u.sent_at, text: u.body ?? "", photoUrl: httpsOnly(u.photo_url) })),
    following: item
      ? { id: item.id, name: item.name, photoUrl: item.photo_url ?? null, focus: `${item.photo_focus_x ?? 50}% ${item.photo_focus_y ?? 38}%` }
      : null,
    choices: (choices ?? []).map((choice) => ({ id: choice.id, name: choice.name, photoUrl: choice.photo_url ?? null })),
    card: cardSummary(subscription),
    nextCharge: nextChargeDate(subscription),
    payments: paymentRows(stripe?.invoices),
    stripeReached: Boolean(stripe),
  };
}
