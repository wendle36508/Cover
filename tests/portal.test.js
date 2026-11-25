// Tests for supabase/functions/_shared/portal.js (the My gifts page's server logic) and the
// "Manage my gift" links in email.js. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adoptionEmail, makeManageToken, MANAGE_LINK_DAILY_CAP, manageLinkEmail, manageLinkFits, manageUrl, normalizeEmail, readManageToken, updateEmail,
} from "../supabase/functions/_shared/email.js";
import {
  amountChange, BadInput, canChange, cardSession, cardSummary, giftView, MAX_MONTHLY_CENTS, MIN_MONTHLY_CENTS, nextChargeDate, paymentRows,
  portalConfiguration, readAmountCents, visibleSponsorships,
} from "../supabase/functions/_shared/portal.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const DAY = 86400 * 1000;

// ---------- Manage links ----------

test("a manage link names one email address (cleaned up) and reads back", async () => {
  const token = await makeManageToken(SECRET, "  Sarah@Example.COM ");
  assert.deepEqual(await readManageToken(SECRET, token), { email: "sarah@example.com" });
  assert.match(manageUrl(token), /^https:\/\/covergiving\.com\/gifts\.html\?t=/);
});

test("manage links expire after 60 days", async () => {
  const now = Date.UTC(2026, 10, 20);
  const token = await makeManageToken(SECRET, "a@b.co", now);
  assert.ok(await readManageToken(SECRET, token, now + 59 * DAY));
  assert.equal(await readManageToken(SECRET, token, now + 61 * DAY), null);
});

test("fake, edited, wrongly signed or other kinds of links are refused", async () => {
  const token = await makeManageToken(SECRET, "a@b.co");
  const [, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "victim@b.co", p: "manage", x: 9999999999 })).toString("base64url");
  for (const bad of ["", "x.y", `${forged}.${sig}`, `${token}x`, `${token}.extra`, null, undefined]) {
    assert.equal(await readManageToken(SECRET, bad), null, String(bad));
  }
  assert.equal(await readManageToken("another-secret-that-is-long-enough-12345", token), null);
  const neverExpires = Buffer.from(JSON.stringify({ e: "a@b.co", p: "manage", x: 0 })).toString("base64url");
  assert.equal(await readManageToken(SECRET, `${neverExpires}.${sig}`), null);
});

test("a manage link needs a real email, and a short secret is refused", async () => {
  await assert.rejects(() => makeManageToken(SECRET, "not an email"));
  await assert.rejects(() => makeManageToken("short", "a@b.co"));
  assert.equal(normalizeEmail("bad@"), "");
  assert.equal(normalizeEmail(`${"a".repeat(250)}@b.co`), "");
});

test("emails carry a Manage my gift link instead of 'reply to cancel'", () => {
  const base = { nonprofitName: "Harbor Paws", kind: "animal", firstName: "Sarah", stopUrl: "https://covergiving.com/updates.html?a=stop&t=x" };
  const manage = "https://covergiving.com/gifts.html?t=abc";
  const update = updateEmail({ ...base, itemName: "Bella", body: "She learned to sit!", manageUrl: manage });
  const adopted = adoptionEmail({ ...base, finishedName: "Bella", pickUrl: null, manageUrl: manage });
  for (const email of [update, adopted]) {
    assert.match(email.text, /Manage my gift \(card, amount or cancel\): https:\/\/covergiving\.com\/gifts\.html\?t=abc/);
    assert.match(email.html, /href="https:\/\/covergiving\.com\/gifts\.html\?t=abc"[^>]*>Manage my gift</);
    assert.doesNotMatch(email.text, /just reply to this email/);
  }
  const noLink = updateEmail({ ...base, itemName: "Bella", body: "Hi" });
  assert.match(noLink.text, /just reply to this email/, "falls back to the old line if there's no link");
});

test("the link email never says whether someone sponsors, and escapes the link", () => {
  const email = manageLinkEmail('https://covergiving.com/gifts.html?t=a"b');
  assert.match(email.text, /If you didn't ask for it/);
  assert.match(email.html, /t=a&quot;b/);
  assert.doesNotMatch(email.html, /t=a"b/);
});

test("link emails may use the sign-in room up to 90 a day", () => {
  assert.equal(manageLinkFits(0), true);
  assert.equal(manageLinkFits(MANAGE_LINK_DAILY_CAP - 1), true);
  assert.equal(manageLinkFits(MANAGE_LINK_DAILY_CAP), false);
  assert.equal(manageLinkFits("nonsense"), true);
});

// ---------- Amounts ----------

test("amounts in dollars become cents, within Cover's limits", () => {
  assert.equal(readAmountCents("25"), 2500);
  assert.equal(readAmountCents("$30.50"), 3050);
  assert.equal(readAmountCents(40), 4000);
  assert.equal(readAmountCents(" 5 "), MIN_MONTHLY_CENTS);
  assert.equal(readAmountCents("1000"), MAX_MONTHLY_CENTS);
  for (const bad of ["", "abc", "-5", "4.99", "1000.01", "1e3", "25.505", null, "99999999"]) {
    assert.throws(() => readAmountCents(bad), BadInput, String(bad));
  }
});

test("a new amount keeps the same product and starts with the next charge", () => {
  const subscription = { items: { data: [{ id: "si_1", price: { product: "prod_1", unit_amount: 2500 } }] } };
  assert.deepEqual(amountChange(subscription, 3000), {
    items: [{ id: "si_1", price_data: { currency: "usd", product: "prod_1", unit_amount: 3000, recurring: { interval: "month" } } }],
    proration_behavior: "none",
  });
  const expanded = { items: { data: [{ id: "si_1", price: { product: { id: "prod_2" } } }] } };
  assert.equal(amountChange(expanded, 1000).items[0].price_data.product, "prod_2");
  assert.throws(() => amountChange({ items: { data: [] } }, 1000), BadInput);
  assert.throws(() => amountChange(null, 1000), BadInput);
});

// ---------- What the page shows ----------

test("only gifts Stripe set up are shown (a closed card form isn't a gift)", () => {
  const rows = [
    { id: "a", status: "active", stripe_subscription_id: "sub_a" },
    { id: "b", status: "pending", stripe_subscription_id: null },
    { id: "c", status: "canceled", stripe_subscription_id: "sub_c" },
    { id: "d", status: "past_due", stripe_subscription_id: "sub_d" },
  ];
  assert.deepEqual(visibleSponsorships(rows).map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(visibleSponsorships(null), []);
  assert.equal(canChange("active"), true);
  assert.equal(canChange("past_due"), true);
  assert.equal(canChange("canceled"), false);
});

test("next charge comes from the subscription item (new Stripe API) or the old field", () => {
  assert.equal(nextChargeDate({ status: "active", items: { data: [{ current_period_end: 1795000000 }] } }), new Date(1795000000 * 1000).toISOString());
  assert.equal(nextChargeDate({ status: "active", current_period_end: 1795000000, items: { data: [{}] } }), new Date(1795000000 * 1000).toISOString());
  assert.equal(nextChargeDate({ status: "canceled", current_period_end: 1795000000 }), null);
  assert.equal(nextChargeDate({ status: "active", cancel_at_period_end: true, current_period_end: 1795000000 }), null);
  assert.equal(nextChargeDate(null), null);
});

test("the card on file is described in plain words", () => {
  const card = (brand) => ({ default_payment_method: { type: "card", card: { brand, last4: "4242", exp_month: 4, exp_year: 2028 } } });
  assert.deepEqual(cardSummary(card("visa")), { label: "Visa ending 4242", expires: "4/28" });
  assert.equal(cardSummary(card("amex")).label, "American Express ending 4242");
  assert.deepEqual(cardSummary({ default_payment_method: { type: "link" } }), { label: "Link", expires: null });
  assert.equal(cardSummary({ default_payment_method: "pm_123" }), null, "not expanded");
  assert.equal(cardSummary({}), null);
});

test("past payments: newest first, real charges only, safe receipt links", () => {
  const rows = paymentRows([
    { status: "paid", amount_due: 2500, amount_paid: 2500, created: 100, status_transitions: { paid_at: 200 }, hosted_invoice_url: "https://invoice.stripe.com/i/1" },
    { status: "open", amount_due: 2500, amount_paid: 0, created: 300, hosted_invoice_url: "javascript:alert(1)" },
    { status: "draft", amount_due: 2500, created: 400 },
    { status: "paid", amount_due: 0, amount_paid: 0, created: 500 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: new Date(300000).toISOString(), amountCents: 2500, status: "Didn't go through", paid: false, receiptUrl: null });
  assert.deepEqual(rows[1], { date: new Date(200000).toISOString(), amountCents: 2500, status: "Paid", paid: true, receiptUrl: "https://invoice.stripe.com/i/1" });
  assert.equal(paymentRows(Array.from({ length: 20 }, (_, i) => ({ status: "paid", amount_due: 100, amount_paid: 100, created: i }))).length, 12);
  assert.deepEqual(paymentRows(undefined), []);
});

test("a gift's view uses Stripe's amount when it can, and Cover's record when Stripe is down", () => {
  const sponsor = { id: "s1", status: "active", created_at: "2026-11-01T00:00:00Z", monthly_cents: 2500, updates_off: false, show_name: true };
  const nonprofit = { name: "Harbor Paws", slug: "harbor-paws", kind: "animal", page: { logo: "https://x/logo.png", brandColor: "#E8743B" } };
  const item = { id: "i1", name: "Bella", photo_url: "https://x/bella.jpg" };
  const withStripe = giftView({
    sponsor, nonprofit, item, choices: [item],
    stripe: { subscription: { status: "active", items: { data: [{ price: { unit_amount: 3000 }, current_period_end: 1795000000 }] } }, invoices: [] },
  });
  assert.equal(withStripe.monthlyCents, 3000);
  assert.equal(withStripe.stripeReached, true);
  assert.deepEqual(withStripe.following, { id: "i1", name: "Bella", photoUrl: "https://x/bella.jpg", focus: "50% 38%" });
  assert.equal(withStripe.interval, "month");
  assert.equal(withStripe.certificateUrl, null);
  assert.deepEqual(withStripe.updates, []);
  assert.equal(withStripe.nonprofit.brandColor, "#E8743B");
  const offline = giftView({ sponsor, nonprofit: null, item: null, choices: null, stripe: null });
  assert.equal(offline.monthlyCents, 2500);
  assert.equal(offline.stripeReached, false);
  assert.equal(offline.following, null);
  assert.deepEqual(offline.choices, []);
  assert.deepEqual(offline.payments, []);
});

test("Stripe's card screen only updates cards (cancel stays on Cover so its records stay right)", () => {
  const config = portalConfiguration("https://covergiving.com");
  assert.equal(config.features.payment_method_update.enabled, true);
  assert.equal(config.features.subscription_cancel.enabled, false);
  assert.equal(config.business_profile.privacy_policy_url, "https://covergiving.com/privacy.html");
  const session = cardSession("cus_1", "bpc_1", "https://covergiving.com/gifts.html");
  assert.equal(session.flow_data.type, "payment_method_update");
  assert.equal(session.flow_data.after_completion.redirect.return_url, "https://covergiving.com/gifts.html");
  assert.doesNotMatch(JSON.stringify(session), /t=/, "the secret link never goes to Stripe");
});
