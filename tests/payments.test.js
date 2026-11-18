// Tests for supabase/functions/_shared/sponsorship.js (the server's payment rules). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BadRequest, INTEGRATION_IDENTIFIER, changesForEvent, checkReady, checkoutRequest, corsHeaders,
  invoiceSubscriptionId, parseList, readSignup, statusForSubscription,
} from "../supabase/functions/_shared/sponsorship.js";
import { validateSponsor } from "../docs/js/sponsor.js";

const ITEM_ID = "3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const signup = { slug: "harbor-paws", itemId: ITEM_ID, firstName: " Sarah ", email: "Sarah@Example.com", showName: true };
const nonprofit = { id: "np1", slug: "harbor-paws", name: "Harbor Paws Rescue", is_live: true, stripe_account_id: "acct_123", monthly_price_cents: 2500 };
const item = { id: ITEM_ID, nonprofit_id: "np1", name: "Bella", status: "active" };

// ---------- checking sign-ups on the server ----------

test("a good sign-up is cleaned up", () => {
  assert.deepEqual(readSignup(signup), {
    slug: "harbor-paws", itemId: ITEM_ID, firstName: "Sarah", email: "sarah@example.com", showName: true, lastInitial: null, businessName: null,
  });
});

test("the thank-you wall is opt-in: only an explicit yes counts, and a business name only counts for businesses", () => {
  for (const notYes of [undefined, false, "true", 1, null]) assert.equal(readSignup({ ...signup, showName: notYes }).showName, false, String(notYes));
  assert.equal(readSignup({ ...signup, businessName: "Sneaky Inc" }).businessName, null);
  assert.equal(readSignup({ ...signup, isBusiness: true, businessName: "Corner Cafe" }).businessName, "Corner Cafe");
});

test("last initial: one letter, cleaned up, and only kept when they opted in", () => {
  assert.equal(readSignup({ ...signup, lastInitial: " k. " }).lastInitial, "K");
  assert.equal(readSignup({ ...signup, lastInitial: "" }).lastInitial, null);
  assert.equal(readSignup({ ...signup, showName: false, lastInitial: "K" }).lastInitial, null);
  assert.equal(readSignup({ ...signup, lastInitial: 7 }).lastInitial, null);
  for (const bad of ["KL", "1", "<", "é"]) assert.throws(() => readSignup({ ...signup, lastInitial: bad }), /one letter/, bad);
});

const badSignups = [
  ["no body", null, /JSON/],
  ["not an object", "hello", /JSON/],
  ["bad page link", { ...signup, slug: "../../etc" }, /doesn't exist/],
  ["missing item", { ...signup, itemId: "" }, /Pick something/],
  ["item that isn't an id", { ...signup, itemId: "1; drop table sponsors" }, /Pick something/],
  ["missing name", { ...signup, firstName: "  " }, /first name/],
  ["long name", { ...signup, firstName: "x".repeat(41) }, /first name/],
  ["bad email", { ...signup, email: "sarah@" }, /email/],
  ["business without a name", { ...signup, isBusiness: true, businessName: "" }, /business name/],
  ["isBusiness as text doesn't count", { ...signup, isBusiness: "yes", businessName: "" }, null],
];
for (const [label, body, message] of badSignups) {
  test(`server sign-up check: ${label}`, () => {
    if (message) assert.throws(() => readSignup(body), (error) => error instanceof BadRequest && message.test(error.message));
    else assert.doesNotThrow(() => readSignup(body));
  });
}

test("the server and the browser agree on names and emails", () => {
  const samples = ["", " ", "a", "x".repeat(40), "x".repeat(41)].flatMap((firstName) =>
    ["", "a@b.co", "bad", "sa rah@x.com", "ok@example.org"].map((email) => ({ firstName, email })));
  for (const sample of samples) {
    const browserOk = validateSponsor({ ...sample, showName: true, isBusiness: false }).ok;
    let serverOk = true;
    try {
      readSignup({ ...signup, ...sample });
    } catch {
      serverOk = false;
    }
    assert.equal(serverOk, browserOk, JSON.stringify(sample));
  }
});

// ---------- is the nonprofit ready to take money ----------

test("a live nonprofit with Stripe and an active item is ready", () => {
  assert.doesNotThrow(() => checkReady(nonprofit, item));
});

for (const [label, np, it, message] of [
  ["missing nonprofit", null, item, /isn't taking sponsors/],
  ["page not live", { ...nonprofit, is_live: false }, item, /isn't taking sponsors/],
  ["no Stripe account", { ...nonprofit, stripe_account_id: null }, item, /setting up payments/],
  ["missing item", nonprofit, null, /can't be sponsored/],
  ["item from another nonprofit", nonprofit, { ...item, nonprofit_id: "np2" }, /can't be sponsored/],
  ["finished item (already adopted)", nonprofit, { ...item, status: "finished" }, /can't be sponsored/],
]) {
  test(`not ready: ${label}`, () => {
    assert.throws(() => checkReady(np, it), (error) => error instanceof BadRequest && message.test(error.message));
  });
}

// ---------- the Stripe card-form request ----------

test("the card form is a monthly subscription shown inside the page", () => {
  const request = checkoutRequest({ nonprofit, item, sponsorId: "sp_1", signup: readSignup(signup), siteUrl: "https://cover.example" });
  assert.equal(request.mode, "subscription");
  assert.equal(request.ui_mode, "embedded_page");
  assert.equal(request.redirect_on_completion, "if_required");
  assert.equal(request.customer_email, "sarah@example.com");
  assert.equal(request.client_reference_id, "sp_1");
  assert.equal(request.integration_identifier, INTEGRATION_IDENTIFIER);
  assert.deepEqual(request.line_items[0].price_data.recurring, { interval: "month" });
  assert.equal(request.line_items[0].price_data.unit_amount, 2500);
  assert.equal(request.line_items[0].price_data.currency, "usd");
  assert.match(request.line_items[0].price_data.product_data.name, /Harbor Paws Rescue/);
  assert.equal(request.metadata.cover_sponsor_id, "sp_1");
  assert.equal(request.return_url, "https://cover.example/give.html?org=harbor-paws&session_id={CHECKOUT_SESSION_ID}");
});

test("the card form never pins payment method types (Stripe picks the best ones)", () => {
  const request = checkoutRequest({ nonprofit, item, sponsorId: "sp_1", signup: readSignup(signup), siteUrl: "https://cover.example/" });
  assert.ok(!("payment_method_types" in request));
  assert.equal(request.return_url, "https://cover.example/give.html?org=harbor-paws&session_id={CHECKOUT_SESSION_ID}");
});

test("the return link works when the site lives in a folder", () => {
  const request = checkoutRequest({ nonprofit, item, sponsorId: "s", signup: readSignup(signup), siteUrl: "http://127.0.0.1:8765/docs" });
  assert.equal(request.return_url, "http://127.0.0.1:8765/docs/give.html?org=harbor-paws&session_id={CHECKOUT_SESSION_ID}");
});

// ---------- turning Stripe's messages into sponsor statuses ----------

const event = (type, object) => ({ id: "evt_1", type, account: "acct_123", data: { object } });

test("a paid checkout makes the sponsor active and saves the Stripe ids", () => {
  const { changes, needsReview } = changesForEvent(event("checkout.session.completed", {
    id: "cs_1", payment_status: "paid", customer: "cus_1", subscription: "sub_1",
  }));
  assert.deepEqual(changes, [{ by: "session", id: "cs_1", set: { status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" } }]);
  assert.equal(needsReview, false);
});

test("a completed but unpaid checkout (bank transfer still pending) changes nothing yet", () => {
  assert.deepEqual(changesForEvent(event("checkout.session.completed", { id: "cs_1", payment_status: "unpaid" })).changes, []);
});

test("a delayed payment that later succeeds activates the sponsor", () => {
  const { changes } = changesForEvent(event("checkout.session.async_payment_succeeded", { id: "cs_1", payment_status: "paid", customer: { id: "cus_9" }, subscription: { id: "sub_9" } }));
  assert.equal(changes[0].set.stripe_customer_id, "cus_9");
  assert.equal(changes[0].set.stripe_subscription_id, "sub_9");
});

test("failed or abandoned checkouts cancel only pending sponsors", () => {
  for (const type of ["checkout.session.async_payment_failed", "checkout.session.expired"]) {
    assert.deepEqual(changesForEvent(event(type, { id: "cs_2" })).changes, [{ by: "session", id: "cs_2", set: { status: "canceled" }, onlyIfPending: true }]);
  }
});

test("subscription changes map to sponsor statuses", () => {
  assert.equal(changesForEvent(event("customer.subscription.updated", { id: "sub_1", status: "past_due" })).changes[0].set.status, "past_due");
  assert.equal(changesForEvent(event("customer.subscription.updated", { id: "sub_1", status: "active" })).changes[0].set.status, "active");
  assert.equal(changesForEvent(event("customer.subscription.deleted", { id: "sub_1", status: "active" })).changes[0].set.status, "canceled");
});

test("failed and paid invoices update the sponsor, in old and new Stripe shapes", () => {
  const newShape = { parent: { subscription_details: { subscription: "sub_new" } } };
  const oldShape = { subscription: "sub_old" };
  assert.deepEqual(changesForEvent(event("invoice.payment_failed", newShape)).changes, [{ by: "subscription", id: "sub_new", set: { status: "past_due" } }]);
  assert.deepEqual(changesForEvent(event("invoice.paid", oldShape)).changes, [{ by: "subscription", id: "sub_old", set: { status: "active" } }]);
  assert.deepEqual(changesForEvent(event("invoice.payment_failed", {})).changes, []);
});

test("disputes, refunds and fraud warnings are flagged for review", () => {
  for (const type of ["charge.dispute.created", "charge.refunded", "radar.early_fraud_warning.created"]) {
    assert.equal(changesForEvent(event(type, {})).needsReview, true);
  }
});

test("unknown or broken events change nothing", () => {
  assert.deepEqual(changesForEvent(event("customer.created", {})), { changes: [], needsReview: false });
  assert.deepEqual(changesForEvent(undefined), { changes: [], needsReview: false });
  assert.deepEqual(changesForEvent({ type: "checkout.session.completed" }).changes, []);
});

test("subscription status mapping covers every Stripe status", () => {
  const expected = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled", incomplete: "pending", paused: "pending", brand_new: "pending" };
  for (const [stripe, cover] of Object.entries(expected)) assert.equal(statusForSubscription(stripe), cover, stripe);
});

test("invoice subscription id handles expanded objects and missing data", () => {
  assert.equal(invoiceSubscriptionId({ subscription: { id: "sub_x" } }), "sub_x");
  assert.equal(invoiceSubscriptionId(null), null);
});

// ---------- browser access rules ----------

test("only Cover's own site addresses are allowed to call the server", () => {
  const allowed = ["http://127.0.0.1:8765", "https://cover.example"];
  assert.equal(corsHeaders("https://cover.example", allowed)["Access-Control-Allow-Origin"], "https://cover.example");
  assert.equal(corsHeaders("https://evil.example", allowed)["Access-Control-Allow-Origin"], "http://127.0.0.1:8765");
  assert.equal(corsHeaders("x", [])["Access-Control-Allow-Origin"], "");
  assert.deepEqual(parseList(" a , ,b,"), ["a", "b"]);
  assert.deepEqual(parseList(undefined), []);
});

// ---------- checkout protection and nightly re-sync ----------

test("client IP comes from the first forwarded address, with fallbacks", async () => {
  const { clientIp } = await import("../supabase/functions/_shared/sponsorship.js");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp({ "cf-connecting-ip": "198.51.100.2" }), "198.51.100.2");
  assert.equal(clientIp(new Headers()), "");
  assert.equal(clientIp(null), "");
});

test("bot check only passes on an explicit success; rate limit message never says which limit", async () => {
  const { turnstilePassed, rateLimitMessage } = await import("../supabase/functions/_shared/sponsorship.js");
  assert.equal(turnstilePassed({ success: true }), true);
  for (const bad of [{ success: false }, { success: "true" }, null, {}]) assert.equal(turnstilePassed(bad), false);
  assert.equal(rateLimitMessage("ok"), null);
  assert.equal(rateLimitMessage("ip"), rateLimitMessage("email"));
  assert.doesNotMatch(rateLimitMessage("ip"), /ip|email/i);
});

test("nightly re-sync: Stripe wins, and missed payments are caught", async () => {
  const { syncAction } = await import("../supabase/functions/_shared/sponsorship.js");
  const now = new Date("2026-12-02T07:30:00Z");
  const old = "2026-11-28T10:00:00Z";
  assert.equal(syncAction({ status: "active" }, { subscriptionStatus: "active" }, now), null, "matches: nothing to do");
  assert.deepEqual(syncAction({ status: "active" }, { subscriptionStatus: "canceled" }, now),
    { set: { status: "canceled" }, kind: "status_fixed", stripeStatus: "canceled" });
  assert.deepEqual(syncAction({ status: "active" }, { subscriptionStatus: "past_due" }, now).set, { status: "past_due" });
  assert.equal(syncAction({ status: "active" }, { subscriptionStatus: "incomplete" }, now), null, "never downgrades to pending");
  assert.deepEqual(syncAction({ status: "pending", created_at: old }, { sessionStatus: "complete", paymentStatus: "paid", subscriptionId: "sub_1" }, now),
    { set: { status: "active", stripe_subscription_id: "sub_1" }, kind: "missed_payment_update", stripeStatus: "complete" });
  assert.deepEqual(syncAction({ status: "pending", created_at: old }, { sessionStatus: "expired" }, now),
    { set: { status: "canceled" }, kind: null, stripeStatus: "expired" }, "abandoned card forms are tidied quietly");
  assert.equal(syncAction({ status: "pending", created_at: "2026-12-02T06:00:00Z" }, { sessionStatus: "expired" }, now), null, "too new to tidy");
  assert.equal(syncAction({ status: "pending", created_at: old }, { sessionStatus: "open" }, now), null);
  assert.equal(syncAction({ status: "active" }, { missing: true }, now).kind, "not_in_stripe");
  assert.equal(syncAction(null, {}, now), null);
});
