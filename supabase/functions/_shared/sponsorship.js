// sponsorship.js - the payment rules Cover's server code follows.
// Plain JavaScript with no Stripe or database code inside, so every rule can be tested with Node.
// The two server functions (create-sponsorship, stripe-webhook) pass in the real Stripe and database.
//
// Sign-up checks mirror docs/js/sponsor.js (the browser checks them first for speed; the server
// checks again because anyone can send requests straight to the server).

export const LIMITS = { firstName: 40, email: 254, businessName: 80 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A fixed label (with 8 random letters, as Stripe recommends) so Cover's checkouts are easy to find in Stripe.
export const INTEGRATION_IDENTIFIER = "cover_sponsor_page_qkzmwtrb";

/** Thrown for anything the visitor sent wrong. The message is safe to show them. */
export class BadRequest extends Error {}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Check a sponsor sign-up sent to the server. Returns clean values or throws BadRequest.
 * Expects { slug, itemId, firstName, email, showName, isBusiness, businessName }.
 */
export function readSignup(body) {
  if (!body || typeof body !== "object") throw new BadRequest("Send the sign-up as JSON.");
  const slug = cleanText(body.slug).toLowerCase();
  const itemId = cleanText(body.itemId);
  const firstName = cleanText(body.firstName);
  const email = cleanText(body.email).toLowerCase();
  const isBusiness = body.isBusiness === true;
  const businessName = isBusiness ? cleanText(body.businessName) : "";

  if (!SLUG_PATTERN.test(slug) || slug.length > 60) throw new BadRequest("That nonprofit page doesn't exist.");
  if (!UUID_PATTERN.test(itemId)) throw new BadRequest("Pick something to sponsor.");
  if (!firstName || firstName.length > LIMITS.firstName) throw new BadRequest("Add your first name (under 40 characters).");
  if (!email || email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) throw new BadRequest("That email doesn't look right.");
  if (isBusiness && (!businessName || businessName.length > LIMITS.businessName)) {
    throw new BadRequest("Add your business name (under 80 characters).");
  }
  return { slug, itemId, firstName, email, showName: body.showName !== false, businessName: businessName || null };
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
export function checkoutRequest({ nonprofit, item, sponsorId, signup, siteUrl }) {
  const returnUrl = new URL("give.html", siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`);
  returnUrl.searchParams.set("org", nonprofit.slug);
  return {
    mode: "subscription",
    ui_mode: "embedded_page",
    redirect_on_completion: "if_required",
    return_url: `${returnUrl.href}&session_id={CHECKOUT_SESSION_ID}`,
    customer_email: signup.email,
    client_reference_id: sponsorId,
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: nonprofit.monthly_price_cents,
          recurring: { interval: "month" },
          product_data: { name: `Monthly sponsorship · ${nonprofit.name}`, description: `Following ${item.name}` },
        },
      },
    ],
    metadata: { cover_sponsor_id: sponsorId },
    subscription_data: { metadata: { cover_sponsor_id: sponsorId, cover_item: item.name } },
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    Vary: "Origin",
  };
}

/** Comma-separated list from an environment setting, with blanks removed. */
export function parseList(value) {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}
