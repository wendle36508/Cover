// Tests for the new checkout (phase 3): any amount; Monthly, Yearly or One time; gifts; Cover's fee on
// one-time gifts; how one-time gifts are recorded; totals; and yearly gifts in My gifts. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { buttonText, frequencyNote, FREQUENCIES, latestGiftDay, readAmount, todayIso } from "../docs/js/checkout-logic.js";
import { chargePlan, oneTimeFeeCents } from "../supabase/functions/_shared/fees.js";
import { amountChange, readAmountCents, subscriptionInterval } from "../supabase/functions/_shared/portal.js";
import { changesForEvent, checkoutRequest, INTERVALS, monthlyEquivalent, readGift, readGiving, readSignup, syncAction } from "../supabase/functions/_shared/sponsorship.js";

const NOW = new Date("2026-11-23T15:00:00Z");
const ITEM = { id: "11111111-1111-4111-8111-111111111111", name: "Burt" };
const NONPROFIT = { id: "np", slug: "lucky-pup-rescue", name: "Lucky Pup Rescue", monthly_price_cents: 2500 };
const SIGNUP = { slug: "lucky-pup-rescue", itemId: ITEM.id, firstName: "Sarah", email: "sarah@example.com" };
const request = (plan, signup = SIGNUP) => checkoutRequest({ nonprofit: NONPROFIT, item: ITEM, sponsorId: "s1", signup, siteUrl: "https://covergiving.com", plan });

// ---------- the page ----------

test("Monthly comes first, then Yearly and One time", () => {
  assert.deepEqual(FREQUENCIES.map((f) => f.label), ["Monthly", "Yearly", "One time"]);
});

test("any amount from $5, with a top limit for each frequency", () => {
  assert.deepEqual(readAmount("18"), { cents: 1800 });
  assert.deepEqual(readAmount("$30.50"), { cents: 3050 });
  assert.deepEqual(readAmount("1,000"), { cents: 100000 });
  assert.match(readAmount("4.99").error, /smallest gift is \$5/);
  assert.match(readAmount("1001").error, /largest gift here is \$1,000 a month/);
  assert.deepEqual(readAmount("1200", "year"), { cents: 120000 });
  assert.match(readAmount("12001", "year").error, /\$12,000 a year/);
  assert.deepEqual(readAmount("5000", "once"), { cents: 500000 });
  for (const bad of ["", "ten", "-5", "25.555", "1e3"]) assert.match(readAmount(bad).error, /like 25/, bad);
});

test("the button says exactly what will happen", () => {
  assert.equal(buttonText(1800, "month"), "Continue to $18 a month");
  assert.equal(buttonText(20000, "year"), "Continue to $200 a year");
  assert.equal(buttonText(5000, "once"), "Continue to give $50");
  assert.equal(buttonText(null, "month"), "Continue", "nothing typed yet");
});

test("one-time givers are told what they get", () => {
  assert.equal(frequencyNote("once", "Burt", false), "You'll get a thank-you and a receipt.", "without the certificate");
  assert.match(frequencyNote("once", "Burt", true), /Burt's photo certificate/);
  assert.match(frequencyNote("month", "Burt"), /change it or cancel anytime/);
});

test("gift days: today up to a year from now", () => {
  const evening = new Date("2026-11-23T23:30:00-05:00");
  assert.match(todayIso(evening), /^2026-11-2[34]$/);
  assert.equal(latestGiftDay(NOW).slice(0, 4), "2027");
});

// ---------- the server ----------

test("the server reads how often and how much; the old page still works without them", () => {
  assert.deepEqual(readGiving({}), { interval: "month", amountCents: null, gift: null });
  assert.deepEqual(readGiving({ interval: "year", amountCents: 20000 }), { interval: "year", amountCents: 20000, gift: null });
  assert.equal(readGiving({ interval: "weekly", amountCents: 1000 }).interval, "month", "unknown frequencies fall back to monthly");
  assert.throws(() => readGiving({ amountCents: 499 }), /smallest gift is \$5/);
  assert.throws(() => readGiving({ amountCents: 100001 }), /\$1,000 a month/);
  assert.throws(() => readGiving({ interval: "once", amountCents: 1000001 }), /\$10,000 one time/);
  assert.throws(() => readGiving({ amountCents: 25.5 }), /like 25/, "cents must be whole");
  assert.equal(readGiving({ interval: "year", amountCents: INTERVALS.year.maxCents }).amountCents, 1200000);
  const signup = readSignup({ ...SIGNUP, interval: "once", amountCents: 5000, returnTo: "sponsor" });
  assert.deepEqual([signup.interval, signup.amountCents, signup.returnTo], ["once", 5000, "sponsor"]);
});

test("gift details are checked: name, email, message, and a sensible day", () => {
  assert.equal(readGift(undefined), null);
  assert.deepEqual(readGift({ name: " Mom ", email: "Mom@Example.com ", message: "", sendOn: "2026-12-25" }, NOW), { name: "Mom", email: "mom@example.com", message: null, sendOn: "2026-12-25" });
  assert.equal(readGift({ name: "Mom", email: "mom@example.com" }, NOW).sendOn, "2026-11-23", "no day: today");
  for (const [label, gift] of [["no name", { email: "a@b.co" }], ["bad email", { name: "A", email: "nope" }], ["long message", { name: "A", email: "a@b.co", message: "x".repeat(301) }],
    ["past day", { name: "A", email: "a@b.co", sendOn: "2026-11-01" }], ["too far", { name: "A", email: "a@b.co", sendOn: "2028-01-01" }], ["junk day", { name: "A", email: "a@b.co", sendOn: "soon" }], ["a list", ["x"]]]) {
    assert.throws(() => readGift(gift, NOW), undefined, label);
  }
});

test("totals use the monthly equivalent: $200 a year counts as $16.67 a month", () => {
  assert.equal(monthlyEquivalent(1800, "month"), 1800);
  assert.equal(monthlyEquivalent(20000, "year"), 1667);
  assert.equal(monthlyEquivalent(5000, "once"), 5000, "one-time gifts never count as ongoing (status gave_once)");
});

test("checkout: monthly is unchanged, yearly bills once a year", () => {
  const monthly = request({ ...chargePlan({ giftCents: 1800, feeOn: false }), giftCents: 1800, interval: "month" });
  assert.equal(monthly.mode, "subscription");
  assert.deepEqual(monthly.line_items[0].price_data.recurring, { interval: "month" });
  assert.equal(monthly.line_items[0].price_data.unit_amount, 1800);
  const yearly = request({ ...chargePlan({ giftCents: 20000, feeOn: true, coverFee: false }), giftCents: 20000, interval: "year" });
  assert.deepEqual(yearly.line_items[0].price_data.recurring, { interval: "year" });
  assert.equal(yearly.line_items[0].price_data.product_data.name, "Yearly sponsorship · Lucky Pup Rescue");
  assert.equal(yearly.subscription_data.application_fee_percent, 3);
  assert.equal(request(undefined).line_items[0].price_data.unit_amount, 2500, "the old page: the nonprofit's price, monthly");
});

test("checkout: a one-time gift is a single payment; Cover's fee is a fixed amount when on", () => {
  const off = request({ ...chargePlan({ giftCents: 5000, feeOn: false, coverFee: true }), giftCents: 5000, interval: "once" });
  assert.equal(off.mode, "payment");
  assert.equal(off.line_items[0].price_data.unit_amount, 5000);
  assert.equal(off.line_items[0].price_data.recurring, undefined);
  assert.equal(off.line_items[0].price_data.product_data.name, "Gift to Lucky Pup Rescue");
  assert.equal(off.subscription_data, undefined);
  assert.deepEqual(off.payment_intent_data, { metadata: { cover_sponsor_id: "s1", cover_item: "Burt" } });
  const on = request({ ...chargePlan({ giftCents: 5000, feeOn: true, coverFee: true }), giftCents: 5000, interval: "once" });
  assert.equal(on.line_items[0].price_data.unit_amount, 5155);
  assert.equal(on.payment_intent_data.application_fee_amount, 155);
  assert.equal(oneTimeFeeCents(5000, 0), 0);
  assert.equal(oneTimeFeeCents(5000, 3), 150);
});

test("checkout from the new pages comes back to the new pages", () => {
  const plan = { ...chargePlan({ giftCents: 1800, feeOn: false }), giftCents: 1800, interval: "month" };
  assert.match(request(plan, { ...SIGNUP, returnTo: "sponsor" }).return_url, /^https:\/\/covergiving\.com\/sponsor\.html\?org=lucky-pup-rescue&session_id=/);
  assert.match(request(plan, SIGNUP).return_url, /\/give\.html\?/);
});

test("a paid one-time gift is recorded as given once, never as an ongoing sponsor", () => {
  const event = (type, object) => ({ type, data: { object } });
  const once = changesForEvent(event("checkout.session.completed", { id: "cs_1", mode: "payment", payment_status: "paid", customer: "cus_1" })).changes;
  assert.deepEqual(once, [{ by: "session", id: "cs_1", set: { status: "gave_once", stripe_customer_id: "cus_1" }, onlyIfPending: true }]);
  const unpaid = changesForEvent(event("checkout.session.completed", { id: "cs_2", mode: "payment", payment_status: "unpaid" })).changes;
  assert.deepEqual(unpaid, [], "a bank payment still on its way: wait");
  const monthly = changesForEvent(event("checkout.session.completed", { id: "cs_3", mode: "subscription", payment_status: "paid", subscription: "sub_1" })).changes;
  assert.equal(monthly[0].set.status, "active");
  assert.deepEqual(syncAction({ status: "pending", created_at: NOW.toISOString() }, { sessionStatus: "complete", paymentStatus: "paid", mode: "payment" }, NOW).set, { status: "gave_once" }, "the nightly check catches a missed one");
});

test("My gifts: a yearly gift stays yearly when the amount changes, with yearly limits", () => {
  const yearly = { items: { data: [{ id: "si_1", price: { product: "prod_1", recurring: { interval: "year" } } }] } };
  const monthly = { items: { data: [{ id: "si_1", price: { product: "prod_1", recurring: { interval: "month" } } }] } };
  assert.equal(subscriptionInterval(yearly), "year");
  assert.equal(subscriptionInterval(monthly), "month");
  assert.equal(subscriptionInterval({}), "month");
  assert.deepEqual(amountChange(yearly, 30000).items[0].price_data.recurring, { interval: "year" });
  assert.deepEqual(amountChange(monthly, 3000).items[0].price_data.recurring, { interval: "month" });
  assert.equal(readAmountCents("3000", "year"), 300000);
  assert.throws(() => readAmountCents("3000", "month"), /largest monthly gift/);
  assert.throws(() => readAmountCents("12001", "year"), /largest yearly gift/);
});

test("owners see each gift's real amount and how often", async () => {
  const { amountLabel, statusLabel } = await import("../docs/js/dashboard-logic.js");
  assert.equal(amountLabel({ monthly_cents: 2500 }), "$25", "older gifts: monthly");
  assert.equal(amountLabel({ monthly_cents: 1667, amount_cents: 20000, interval: "year" }), "$200/yr");
  assert.equal(amountLabel({ monthly_cents: 5000, amount_cents: 5000, interval: "once" }), "$50 once");
  assert.equal(amountLabel({ monthly_cents: 1850, amount_cents: 1850, interval: "month" }), "$18.50");
  assert.deepEqual(statusLabel("gave_once"), { text: "Gave once", tone: "active" });
});
