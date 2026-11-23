// sponsorship.js - the payment rules Cover's server code follows.
// Plain JavaScript with no Stripe or database code inside, so every rule can be tested with Node.
// The two server functions (create-sponsorship, stripe-webhook) pass in the real Stripe and database.
//
// Sign-up checks mirror docs/js/sponsor.js (the browser checks them first for speed; the server
// checks again because anyone can send requests straight to the server).

import { formatCents, oneTimeFeeCents } from "./fees.js";

export const LIMITS = { firstName: 40, email: 254, businessName: 80 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A fixed label (with 8 random letters, as Stripe recommends) so Cover's checkouts are easy to find in Stripe.
export const INTEGRATION_IDENTIFIER = "cover_sponsor_page_qkzmwtrb";

// Monthly gifts take cards only (Apple Pay and Google Pay count as cards) plus Link, Stripe's saved-card
// wallet. "Pay later" options (Klarna, Afterpay, Affirm, Zip) are left out on purpose (Tanner, Nov 18):
// they don't fit a gift that repeats every month. Pinned here so it holds on every nonprofit's
// account, whatever that account's own payment settings say.
export const PAYMENT_METHOD_TYPES = ["card", "link"];

/** Thrown for anything the visitor sent wrong. The message is safe to show them. */
export class BadRequest extends Error {}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Check a sponsor sign-up sent to the server. Returns clean values or throws BadRequest.
 * Expects { slug, itemId, firstName, email, showName, lastInitial, isBusiness, businessName }.
 * showName is the thank-you wall opt-in: only an explicit true counts (off by default).
 */
export function readSignup(body) {
  if (!body || typeof body !== "object") throw new BadRequest("Send the sign-up as JSON.");
  const slug = cleanText(body.slug).toLowerCase();
  const itemId = cleanText(body.itemId);
  const firstName = cleanText(body.firstName);
  const email = cleanText(body.email).toLowerCase();
  const isBusiness = body.isBusiness === true;
  const businessName = isBusiness ? cleanText(body.businessName) : "";
  const showName = body.showName === true;
  const rawInitial = showName && typeof body.lastInitial === "string" ? body.lastInitial.replace(/[.\s]/g, "") : "";

  if (!SLUG_PATTERN.test(slug) || slug.length > 60) throw new BadRequest("That nonprofit page doesn't exist.");
  if (!UUID_PATTERN.test(itemId)) throw new BadRequest("Pick something to sponsor.");
  if (!firstName || firstName.length > LIMITS.firstName) throw new BadRequest("Add your first name (under 40 characters).");
  if (!email || email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) throw new BadRequest("That email doesn't look right.");
  if (isBusiness && (!businessName || businessName.length > LIMITS.businessName)) {
    throw new BadRequest("Add your business name (under 80 characters).");
  }
  if (rawInitial && !/^[A-Za-z]$/.test(rawInitial)) throw new BadRequest("Your last initial should be just one letter.");
  // coverFee: the donor ticked "add 3% so the nonprofit gets my full gift" (only counts when the fee is on).
  // Giving (new checkout): how often, how much, and whether it's a gift. Left out by the old page.
  return {
    slug, itemId, firstName, email, showName, lastInitial: rawInitial ? rawInitial.toUpperCase() : null, businessName: businessName || null,
    coverFee: body.coverFee === true,
    ...readGiving(body),
    returnTo: body.returnTo === "sponsor" ? "sponsor" : "give",
  };
}

/** Can this nonprofit take a payment right now? Throws BadRequest with a reason if not. */
export function checkReady(nonprofit, item) {
  if (!nonprofit || !nonprofit.is_live) throw new BadRequest("That nonprofit page isn't taking sponsors yet.");
  if (!nonprofit.stripe_account_id) throw new BadRequest("That nonprofit hasn't finished setting up payments.");
  if (!item || item.nonprofit_id !== nonprofit.id || item.status !== "active") {
    throw new BadRequest("That one can't be sponsored right now.");
  }
}

/**
 * The Stripe Checkout Session request for one monthly gift, charged on the nonprofit's own
 * Stripe account (direct charge). Send it with { stripeAccount: nonprofit.stripe_account_id }.
 * The card form shows inside Cover's pop-up (embedded_page) and only leaves the page for
 * payment methods that need a redirect.
 */
export function checkoutRequest({ nonprofit, item, sponsorId, signup, siteUrl, plan }) {
  // plan (from fees.js chargePlan) says what to charge and Cover's fee; without one it's the plain gift.
  const giftCents = plan?.giftCents ?? nonprofit.monthly_price_cents;
  const chargedCents = plan?.chargedCents ?? nonprofit.monthly_price_cents;
  const feePercent = plan?.feePercent ?? 0;
  const interval = plan?.interval ?? "month";
  const extraCents = chargedCents - giftCents;
  const description = plan?.coversFee && extraCents > 0
    ? `Following ${item.name} · includes ${formatCents(extraCents)} so ${nonprofit.name} gets the full gift`
    : `Following ${item.name}`;
  const returnUrl = new URL(signup?.returnTo === "sponsor" ? "sponsor.html" : "give.html", siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`);
  returnUrl.searchParams.set("org", nonprofit.slug);
  if (interval === "once") return oneTimeRequest({ nonprofit, item, sponsorId, signup, returnUrl, chargedCents, feePercent, description });
  return {
    mode: "subscription",
    ui_mode: "embedded_page",
    redirect_on_completion: "if_required",
    payment_method_types: PAYMENT_METHOD_TYPES,
    return_url: `${returnUrl.href}&session_id={CHECKOUT_SESSION_ID}`,
    customer_email: signup.email,
    client_reference_id: sponsorId,
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: chargedCents,
          recurring: { interval },
          product_data: { name: `${interval === "year" ? "Yearly" : "Monthly"} sponsorship · ${nonprofit.name}`, description },
        },
      },
    ],
    metadata: { cover_sponsor_id: sponsorId },
    subscription_data: {
      metadata: { cover_sponsor_id: sponsorId, cover_item: item.name },
      // Cover's fee (only when the nonprofit's switch is on): Stripe keeps this % of every monthly
      // payment for Cover, on the nonprofit's own account, and shows it there as a fee.
      ...(feePercent > 0 ? { application_fee_percent: feePercent } : {}),
    },
  };
}

/** The sponsor status Cover shows for a Stripe subscription status. */
export function statusForSubscription(stripeStatus) {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "past_due" || stripeStatus === "unpaid") return "past_due";
  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") return "canceled";
  return "pending"; // incomplete, paused, or anything new
}

/** The subscription id on an invoice, whichever API shape Stripe sent. */
export function invoiceSubscriptionId(invoice) {
  const fromParent = invoice?.parent?.subscription_details?.subscription;
  const legacy = invoice?.subscription;
  const id = fromParent ?? legacy;
  return typeof id === "string" ? id : id?.id ?? null;
}

const REVIEW_EVENTS = new Set(["charge.dispute.created", "charge.refunded", "radar.early_fraud_warning.created"]);

/**
 * What to do with one verified Stripe event. Returns a list of changes for the server to apply:
 *   { by: "session" | "subscription", id, set: { ...columns } }
 * plus needsReview for events a person should look at. Unknown events change nothing.
 */
export function changesForEvent(event) {
  const object = event?.data?.object ?? {};
  const changes = [];
  switch (event?.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // A one-time gift (new checkout): paid once, no subscription. It ends as 'gave_once', never 'active'.
      if (object.mode === "payment" && object.payment_status === "paid") {
        changes.push({
          by: "session",
          id: object.id,
          set: { status: "gave_once", stripe_customer_id: typeof object.customer === "string" ? object.customer : object.customer?.id ?? null },
          onlyIfPending: true,
        });
        break;
      }
      if (object.payment_status === "paid" || object.payment_status === "no_payment_required") {
        changes.push({
          by: "session",
          id: object.id,
          set: {
            status: "active",
            stripe_customer_id: typeof object.customer === "string" ? object.customer : object.customer?.id ?? null,
            stripe_subscription_id: typeof object.subscription === "string" ? object.subscription : object.subscription?.id ?? null,
          },
        });
      }
      break;
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      changes.push({ by: "session", id: object.id, set: { status: "canceled" }, onlyIfPending: true });
      break;
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      changes.push({
        by: "subscription",
        id: object.id,
        set: { status: event.type === "customer.subscription.deleted" ? "canceled" : statusForSubscription(object.status) },
      });
      break;
    case "invoice.payment_failed": {
      const subscriptionId = invoiceSubscriptionId(object);
      if (subscriptionId) changes.push({ by: "subscription", id: subscriptionId, set: { status: "past_due" } });
      break;
    }
    case "invoice.paid": {
      const subscriptionId = invoiceSubscriptionId(object);
      if (subscriptionId) changes.push({ by: "subscription", id: subscriptionId, set: { status: "active" } });
      break;
    }
    default:
      break;
  }
  return { changes, needsReview: REVIEW_EVENTS.has(event?.type) };
}

/** CORS headers: only Cover's own site addresses may call the server from a browser. */
export function corsHeaders(origin, allowedOrigins) {
  const allowed = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    Vary: "Origin",
  };
}

/** Comma-separated list from an environment setting, with blanks removed. */
export function parseList(value) {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

// ---------- Checkout protection (approved Nov 18) ----------

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The visitor's IP address from the request headers (Supabase puts the real one first). "" if unknown. */
export function clientIp(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? "";
  const forwarded = String(get("x-forwarded-for")).split(",")[0].trim();
  return forwarded || String(get("cf-connecting-ip")).trim() || String(get("x-real-ip")).trim();
}

/** Did Cloudflare's bot check pass? Only an explicit success counts. */
export function turnstilePassed(result) {
  return result?.success === true;
}

/**
 * What to do with a checkout after asking Cloudflare. reached = got any answer; status = its HTTP status.
 * "pass", "block", or "allow" (Cloudflare down or erroring: let real donors through; rate limits still apply).
 */
export function botCheckOutcome(reached, status, result) {
  if (!reached || status >= 500) return "allow";
  return turnstilePassed(result) ? "pass" : "block";
}

/** The message a visitor sees when the rate limit stops them (never says which limit). */
export function rateLimitMessage(verdict) {
  return verdict === "ok" ? null : "Too many tries in a short time. Please wait a little while and try again.";
}

// ---------- Nightly Stripe re-sync (approved Nov 18) ----------

const CHECKOUT_GRACE_MS = 24 * 3600 * 1000; // a card form left open less than a day isn't stale yet

/**
 * What to do for one sponsorship after asking Stripe about it.
 * sponsor: { status, created_at }; stripe: { subscriptionStatus } or { sessionStatus, paymentStatus, subscriptionId }
 * or { missing: true }. Returns null (nothing to do) or { set, kind, stripeStatus }.
 */
export function syncAction(sponsor, stripe, now = new Date()) {
  if (!sponsor || !stripe) return null;
  if (stripe.missing) {
    return { set: null, kind: "not_in_stripe", stripeStatus: "missing" };
  }
  if (stripe.subscriptionStatus) {
    const real = statusForSubscription(stripe.subscriptionStatus);
    if (real === "pending" || real === sponsor.status) return null;
    return { set: { status: real }, kind: "status_fixed", stripeStatus: stripe.subscriptionStatus };
  }
  if (sponsor.status !== "pending") return null;
  const paid = stripe.paymentStatus === "paid" || stripe.paymentStatus === "no_payment_required";
  if (stripe.sessionStatus === "complete" && paid && stripe.mode === "payment") {
    return { set: { status: "gave_once" }, kind: "missed_payment_update", stripeStatus: "complete" }; // a one-time gift
  }
  if (stripe.sessionStatus === "complete" && paid) {
    return {
      set: { status: "active", ...(stripe.subscriptionId ? { stripe_subscription_id: stripe.subscriptionId } : {}) },
      kind: "missed_payment_update",
      stripeStatus: "complete",
    };
  }
  const age = now.getTime() - new Date(sponsor.created_at).getTime();
  if (stripe.sessionStatus === "expired" && age > CHECKOUT_GRACE_MS) {
    return { set: { status: "canceled" }, kind: null, stripeStatus: "expired" };
  }
  return null;
}

// ---------- Stripe key check (restricted key, Nov 18) ----------

/**
 * Was a Stripe answer a missing-permission error? The key check makes calls that are meant to fail
 * (made-up ids, an invalid field); any answer EXCEPT "this key isn't allowed" means the permission is there.
 * A made-up nonprofit account can't prove anything ("no access to that account" happens with any key),
 * so those come back as "needs_real_account". Returns { verdict, detail } with verdict
 * "ok" | "missing_permission" | "needs_real_account" | "unknown".
 */
export function keyCheckVerdict(status, payload) {
  const error = payload?.error ?? {};
  const message = String(error.message ?? "");
  if (status === 401) return { verdict: "unknown", detail: "Stripe didn't accept the key at all." };
  if (/does not have access to account|that account does not exist|no such account/i.test(message)) {
    return { verdict: "needs_real_account", detail: "Can only be confirmed on a real nonprofit's Stripe account." };
  }
  if (status === 403 || /required permissions|does not have the required permission|permission_error/i.test(`${message} ${error.type ?? ""}`)) {
    return { verdict: "missing_permission", detail: message.slice(0, 200) };
  }
  return { verdict: "ok", detail: status >= 400 ? (error.code ?? error.type ?? `HTTP ${status}`) : `HTTP ${status}` };
}


// ---------- Giving options (new checkout, phase 3, Nov 23) ----------

export const MIN_GIFT_CENTS = 500; // $5: below this, card fees eat most of the gift
export const INTERVALS = {
  month: { maxCents: 100000, label: "a month" }, // up to $1,000 a month (same as My gifts)
  year: { maxCents: 1200000, label: "a year" }, // up to $12,000 a year
  once: { maxCents: 1000000, label: "one time" }, // up to $10,000 at once
};
const DAY_MS = 86400000;

/**
 * How often, how much, and gift details from the new checkout. Everything is optional, so the old
 * page (which sends none of it) keeps working: interval "month", amount null (the nonprofit's price).
 */
export function readGiving(body, now = new Date()) {
  const interval = Object.hasOwn(INTERVALS, body?.interval ?? "") ? body.interval : "month";
  let amountCents = null;
  if (body?.amountCents !== undefined && body?.amountCents !== null) {
    amountCents = Number(body.amountCents);
    if (!Number.isInteger(amountCents)) throw new BadRequest("Type an amount like 25.");
    if (amountCents < MIN_GIFT_CENTS) throw new BadRequest("The smallest gift is $5.");
    if (amountCents > INTERVALS[interval].maxCents) {
      throw new BadRequest(`The largest gift here is ${formatCents(INTERVALS[interval].maxCents)} ${INTERVALS[interval].label}.`);
    }
  }
  return { interval, amountCents, gift: readGift(body?.gift, now) };
}

/** A gift for someone: their name and email, an optional message, and the day it should arrive. */
export function readGift(gift, now = new Date()) {
  if (gift === undefined || gift === null) return null;
  if (typeof gift !== "object" || Array.isArray(gift)) throw new BadRequest("Something's off with the gift details.");
  const name = cleanText(gift.name);
  const email = cleanText(gift.email).toLowerCase();
  const message = cleanText(gift.message);
  if (!name || name.length > 80) throw new BadRequest("Add the name of the person it's for (under 80 characters).");
  if (!email || email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) throw new BadRequest("Their email doesn't look right.");
  if (message.length > 300) throw new BadRequest("Keep the message under 300 characters.");
  const today = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  let sendOn = today;
  if (gift.sendOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(gift.sendOn))) throw new BadRequest("Pick the day it should arrive.");
    sendOn = new Date(`${gift.sendOn}T00:00:00Z`);
    // A day of leeway either side covers time zones; no further than a year out.
    const tooEarly = sendOn.getTime() < today.getTime() - DAY_MS;
    const tooLate = sendOn.getTime() > today.getTime() + 366 * DAY_MS;
    if (Number.isNaN(sendOn.getTime()) || tooEarly || tooLate) throw new BadRequest("Pick a day between today and a year from now.");
  }
  return { name, email, message: message || null, sendOn: sendOn.toISOString().slice(0, 10) };
}

/** The monthly equivalent every total adds up: $200 a year counts as $16.67 a month; one-time is its amount. */
export function monthlyEquivalent(cents, interval) {
  return interval === "year" ? Math.round(cents / 12) : cents;
}

/** The Stripe Checkout request for a one-time gift (no subscription; Cover's fee as a fixed amount). */
function oneTimeRequest({ nonprofit, item, sponsorId, signup, returnUrl, chargedCents, feePercent, description }) {
  const feeCents = oneTimeFeeCents(chargedCents, feePercent);
  return {
    mode: "payment",
    ui_mode: "embedded_page",
    redirect_on_completion: "if_required",
    payment_method_types: PAYMENT_METHOD_TYPES,
    return_url: `${returnUrl.href}&session_id={CHECKOUT_SESSION_ID}`,
    customer_email: signup.email,
    client_reference_id: sponsorId,
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: chargedCents, product_data: { name: `Gift to ${nonprofit.name}`, description } } }],
    metadata: { cover_sponsor_id: sponsorId },
    payment_intent_data: {
      metadata: { cover_sponsor_id: sponsorId, cover_item: item.name },
      ...(feeCents > 0 ? { application_fee_amount: feeCents } : {}),
    },
  };
}
