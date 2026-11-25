// Tests for Stripe account updates (page on or off to match, one plain-English alert per new request)
// and the "your gift is set" note to whoever buys a gift sponsorship. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { accountHealth } from "../supabase/functions/_shared/connect.js";
import { dayLabel, giftSetEmail, stripeAlertEmail } from "../supabase/functions/_shared/email.js";

const ACTIVE = { charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active" }, requirements: { currently_due: [], past_due: [], disabled_reason: null } };

test("an approved account turns the page on, with nothing to tell anyone", () => {
  assert.deepEqual(accountHealth(ACTIVE), { live: true, problem: null, key: null });
});

test("Stripe still checking what was sent is normal: page off, no alert", () => {
  const checking = { charges_enabled: false, payouts_enabled: false, capabilities: { card_payments: "pending" }, requirements: { currently_due: [], past_due: [], disabled_reason: "requirements.pending_verification" } };
  assert.deepEqual(accountHealth(checking), { live: false, problem: null, key: null });
});

test("Stripe asking for something while gifts still work: page stays on, one gentle alert", () => {
  const asking = { ...ACTIVE, requirements: { currently_due: ["individual.verification.document"], past_due: [], disabled_reason: null } };
  const health = accountHealth(asking);
  assert.equal(health.live, true);
  assert.match(health.problem, /Gifts still work/);
  assert.equal(health.key, "individual.verification.document");
});

test("a paused account turns the page off and says gifts and payouts are waiting", () => {
  const paused = { charges_enabled: false, payouts_enabled: false, capabilities: { card_payments: "inactive" }, requirements: { currently_due: ["company.tax_id"], past_due: ["external_account"], disabled_reason: "requirements.past_due" } };
  const health = accountHealth(paused);
  assert.equal(health.live, false);
  assert.match(health.problem, /before gifts and payouts can continue/);
  assert.equal(health.key, "requirements.past_due,company.tax_id,external_account");
});

test("the same request always has the same key, so it's emailed once", () => {
  const a = accountHealth({ ...ACTIVE, requirements: { currently_due: ["b", "a"], past_due: ["a"] } });
  const b = accountHealth({ ...ACTIVE, requirements: { currently_due: ["a"], past_due: ["b"] } });
  assert.equal(a.key, b.key);
  assert.equal(accountHealth(undefined).live, false, "a strange message never turns a page on");
});

test("the Stripe alert email is plain and links to the payouts screen", () => {
  const email = stripeAlertEmail({ nonprofitName: "Lucky Pup Rescue", problem: "Stripe needs one more thing. Gifts still work, but it should be done soon.", dashboardUrl: "https://covergiving.com/dashboard.html#payments" });
  assert.equal(email.subject, "Stripe needs one more thing for Lucky Pup Rescue");
  assert.match(email.text, /Payments & payouts/);
  assert.match(email.html, /dashboard\.html#payments/);
});

test("gift days read like a person would say them", () => {
  assert.equal(dayLabel("2026-12-25"), "Friday, December 25");
  assert.equal(dayLabel("2027-01-01"), "Friday, January 1");
  assert.equal(dayLabel("soon"), "");
});

test("the gift buyer's note: who, when, the message, a preview, and how to change the day", () => {
  const base = { nonprofitName: "Lucky Pup Rescue", giverName: "Sarah", recipientName: "Linda", itemName: "Burt", today: "2026-11-25",
    certificateUrl: "https://covergiving.com/certificate.html?t=abc", manageUrl: "https://covergiving.com/gifts.html?t=m" };
  const later = giftSetEmail({ ...base, sendOn: "2026-12-25", message: "Merry Christmas, Mom! <3" });
  assert.equal(later.subject, "Your gift for Linda is set");
  assert.match(later.text, /We'll email Linda on Friday, December 25 with Burt's photo certificate and your message/);
  assert.match(later.text, /reply to this email/);
  assert.match(later.text, /certificate\.html\?t=abc/);
  assert.match(later.html, /Merry Christmas, Mom! &lt;3/, "the message can't add HTML");
  assert.match(later.text, /Manage my gift/, "the buyer still manages billing");
  const now = giftSetEmail({ ...base, sendOn: "2026-11-25", message: null });
  assert.match(now.text, /We'll email Linda today with Burt's photo certificate\. From then on/);
  assert.doesNotMatch(now.text, /reply to this email/, "nothing to change when it goes out today");
});
