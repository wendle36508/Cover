// Tests for Cover's 3% fee (built switched OFF, Nov 23): the math, what checkout charges with the
// switch off and on, the donor's "cover it" box, My gifts amounts, receipts, and the page's copy of the math.
// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import * as siteFees from "../docs/js/fees.js";
import { orgFromRows } from "../docs/js/live.js";
import { chargePlan, COVER_FEE_PERCENT, coveredTotalCents, formatCents, giftFromCoveredTotal } from "../supabase/functions/_shared/fees.js";
import { chargeForGift, giftView, paymentRows } from "../supabase/functions/_shared/portal.js";
import { checkoutRequest, readSignup } from "../supabase/functions/_shared/sponsorship.js";

const ITEM = { id: "11111111-1111-4111-8111-111111111111", name: "Burt" };
const NONPROFIT = { id: "np", slug: "lucky-pup-rescue", name: "Lucky Pup Rescue", monthly_price_cents: 2500 };
const SIGNUP = { slug: "lucky-pup-rescue", itemId: ITEM.id, firstName: "Sarah", email: "sarah@example.com" };
const request = (plan) => checkoutRequest({ nonprofit: NONPROFIT, item: ITEM, sponsorId: "s1", signup: SIGNUP, siteUrl: "https://covergiving.com", plan });

test("money reads naturally", () => {
  assert.equal(formatCents(2500), "$25");
  assert.equal(formatCents(2578), "$25.78");
  assert.equal(formatCents(78), "$0.78");
  assert.equal(formatCents(103093), "$1,030.93");
  assert.equal(formatCents(undefined), "$0");
  assert.equal(formatCents(-5), "$0");
});

test("covering the fee adds just enough that the nonprofit gets the whole gift", () => {
  assert.equal(COVER_FEE_PERCENT, 3);
  assert.equal(coveredTotalCents(2500), 2578);
  assert.equal(coveredTotalCents(500), 516);
  assert.equal(coveredTotalCents(100000), 103093);
  assert.equal(coveredTotalCents(0), 0);
  assert.equal(coveredTotalCents("nonsense"), 0);
  assert.equal(coveredTotalCents(2500, 0), 2500, "no fee, nothing added");
  // Every gift from $5 to $1,000: after Stripe takes 3% (rounded to the cent), the nonprofit has at least the gift,
  // the extra is never more than a cent above 3%, and the gift can be read back from the total.
  for (let gift = 500; gift <= 100000; gift += 7) {
    const total = coveredTotalCents(gift);
    assert.ok(total - Math.round(total * 0.03) >= gift, `gift ${gift}`);
    assert.ok(total - gift <= Math.ceil(gift * 0.0310) + 1, `extra for ${gift}`);
    assert.equal(giftFromCoveredTotal(total), gift, `read back ${gift}`);
  }
});

test("the sponsor page's copy of the math matches the server's", () => {
  for (let gift = 0; gift <= 100000; gift += 13) {
    assert.equal(siteFees.coveredTotalCents(gift), coveredTotalCents(gift));
    assert.equal(siteFees.formatCents(gift), formatCents(gift));
  }
  assert.equal(siteFees.COVER_FEE_PERCENT, COVER_FEE_PERCENT);
});

test("fee OFF: no fee, and the cover box is ignored even if someone sends it", () => {
  for (const coverFee of [false, true, "yes", undefined]) {
    assert.deepEqual(chargePlan({ giftCents: 2500, feeOn: false, coverFee }), { chargedCents: 2500, feePercent: 0, coversFee: false });
  }
  assert.deepEqual(chargePlan({ giftCents: 2500, feeOn: undefined, coverFee: true }).feePercent, 0, "missing switch counts as off");
});

test("fee ON: 3% on every gift; ticking the box adds the cover", () => {
  assert.deepEqual(chargePlan({ giftCents: 2500, feeOn: true, coverFee: false }), { chargedCents: 2500, feePercent: 3, coversFee: false });
  assert.deepEqual(chargePlan({ giftCents: 2500, feeOn: true, coverFee: true }), { chargedCents: 2578, feePercent: 3, coversFee: true });
  assert.equal(chargePlan({ giftCents: 2500, feeOn: true, coverFee: "true" }).coversFee, false, "only an explicit yes counts");
});

test("the cover box only counts as an explicit yes from the page", () => {
  for (const notYes of [undefined, false, "true", 1, null]) assert.equal(readSignup({ ...SIGNUP, coverFee: notYes }).coverFee, false, String(notYes));
  assert.equal(readSignup({ ...SIGNUP, coverFee: true }).coverFee, true);
});

test("checkout with the fee OFF is exactly like before: no fee, same price and wording", () => {
  for (const plan of [undefined, chargePlan({ giftCents: 2500, feeOn: false, coverFee: true })]) {
    const req = request(plan);
    assert.equal(req.line_items[0].price_data.unit_amount, 2500);
    assert.equal(req.line_items[0].price_data.product_data.description, "Following Burt");
    assert.deepEqual(req.subscription_data, { metadata: { cover_sponsor_id: "s1", cover_item: "Burt" } });
    assert.doesNotMatch(JSON.stringify(req), /application_fee/);
  }
});

test("checkout with the fee ON: Stripe keeps 3% for Cover; the cover box raises the price and says why", () => {
  const plain = request(chargePlan({ giftCents: 2500, feeOn: true, coverFee: false }));
  assert.equal(plain.subscription_data.application_fee_percent, 3);
  assert.equal(plain.line_items[0].price_data.unit_amount, 2500);
  assert.equal(plain.line_items[0].price_data.product_data.description, "Following Burt");
  const covered = request(chargePlan({ giftCents: 2500, feeOn: true, coverFee: true }));
  assert.equal(covered.subscription_data.application_fee_percent, 3);
  assert.equal(covered.line_items[0].price_data.unit_amount, 2578);
  assert.equal(covered.line_items[0].price_data.product_data.description, "Following Burt · includes $0.78 so Lucky Pup Rescue gets the full gift");
  assert.equal(covered.subscription_data.metadata.cover_sponsor_id, "s1", "the gift is still linked to its sponsor");
});

test("My gifts: changing the amount keeps the cover for donors who chose it, and only them", () => {
  assert.equal(chargeForGift(3000, { covers_fee: true, fee_percent: 3 }), 3093);
  assert.equal(chargeForGift(3000, { covers_fee: false, fee_percent: 3 }), 3000, "fee on, but they didn't cover it");
  assert.equal(chargeForGift(3000, { covers_fee: true, fee_percent: 0 }), 3000, "no fee on this gift");
  assert.equal(chargeForGift(3000, {}), 3000);
});

test("My gifts shows the gift and the cover separately; receipts show what was actually paid", () => {
  const base = { id: "s1", status: "active", created_at: "2026-11-01T00:00:00Z", updates_off: false, show_name: false };
  const stripe = (cents) => ({ subscription: { status: "active", items: { data: [{ price: { unit_amount: cents } }] } }, invoices: [] });
  const covered = giftView({ sponsor: { ...base, monthly_cents: 2578, fee_percent: 3, covers_fee: true }, nonprofit: null, item: null, choices: [], stripe: stripe(2578) });
  assert.deepEqual([covered.monthlyCents, covered.giftCents, covered.coversFee], [2578, 2500, true]);
  const plain = giftView({ sponsor: { ...base, monthly_cents: 2500, fee_percent: 3, covers_fee: false }, nonprofit: null, item: null, choices: [], stripe: stripe(2500) });
  assert.deepEqual([plain.monthlyCents, plain.giftCents, plain.coversFee], [2500, 2500, false]);
  const pilot = giftView({ sponsor: { ...base, monthly_cents: 2500 }, nonprofit: null, item: null, choices: [], stripe: null });
  assert.deepEqual([pilot.monthlyCents, pilot.giftCents, pilot.coversFee], [2500, 2500, false], "gifts from before the fee look the same");
  const rows = paymentRows([{ status: "paid", amount_due: 2578, amount_paid: 2578, created: 100, status_transitions: { paid_at: 100 }, hosted_invoice_url: "https://invoice.stripe.com/i/1" }]);
  assert.equal(rows[0].amountCents, 2578, "the receipt shows the full amount the donor gave");
});

test("the sponsor page knows whether the fee is on; it's off unless the database says so", () => {
  const np = { id: "np", slug: "x", name: "X", kind: "animal", monthly_price_cents: 2550, monthly_goal_cents: 200000, page: {} };
  assert.equal(orgFromRows(np, []).feeOn, false);
  assert.equal(orgFromRows({ ...np, cover_fee_on: true }, []).feeOn, true);
  assert.equal(orgFromRows({ ...np, cover_fee_on: "yes" }, []).feeOn, false);
  assert.equal(orgFromRows(np, []).priceCents, 2550, "cents kept for the button (no rounding $25.50 to $26)");
});
