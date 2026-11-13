// Tests for docs/js/sponsor.js. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { ORGS } from "../docs/js/orgs.js";
import {
  LIMITS, buildRecord, cleanText, money, paymentUrl, percentCovered, publicName,
  sponsorLabel, thankYou, timeAgo, validateSponsor, withNewSponsor,
} from "../docs/js/sponsor.js";

const good = { firstName: "Sarah", email: "sarah@example.com", showName: true, isBusiness: false, businessName: "" };
const rescue = ORGS.rescue;
const bella = rescue.items[0];

// ---------- cleaning and checking the form ----------

test("cleanText trims, squashes spaces, and turns non-text into empty", () => {
  assert.equal(cleanText("  Sarah   Jane "), "Sarah Jane");
  for (const bad of [undefined, null, 42, {}, []]) assert.equal(cleanText(bad), "");
});

test("a normal sponsor passes and the email is lowercased", () => {
  const result = validateSponsor({ ...good, email: " Sarah@Example.COM " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.values.email, "sarah@example.com");
});

test("empty form names every missing field", () => {
  const result = validateSponsor({});
  assert.equal(result.ok, false);
  assert.match(result.errors.firstName, /first name/);
  assert.match(result.errors.email, /email/);
});

test("a missing form object doesn't crash", () => {
  assert.equal(validateSponsor(undefined).ok, false);
});

for (const email of ["sarah", "sarah@", "@example.com", "sarah@example", "sa rah@example.com", "a@b.c"]) {
  test(`bad email is rejected: ${email}`, () => {
    assert.equal(validateSponsor({ ...good, email }).errors.email, "That email doesn't look right.");
  });
}

test("names and emails over the limit are rejected", () => {
  assert.match(validateSponsor({ ...good, firstName: "x".repeat(LIMITS.firstName + 1) }).errors.firstName, /under/);
  const longEmail = `${"x".repeat(LIMITS.email)}@example.com`;
  assert.equal(validateSponsor({ ...good, email: longEmail }).errors.email, "That email doesn't look right.");
});

test("names at exactly the limit pass", () => {
  assert.equal(validateSponsor({ ...good, firstName: "x".repeat(LIMITS.firstName) }).ok, true);
});

test("a business sponsor needs a business name", () => {
  assert.match(validateSponsor({ ...good, isBusiness: true }).errors.businessName, /business name/);
  assert.equal(validateSponsor({ ...good, isBusiness: true, businessName: "Bay Street Hardware" }).ok, true);
});

test("a business name is dropped when the business box isn't checked", () => {
  assert.equal(validateSponsor({ ...good, businessName: "Leftover Inc" }).values.businessName, "");
});

test("names that look like code are kept as plain text, not rejected", () => {
  const result = validateSponsor({ ...good, firstName: "<b>Sam</b>" });
  assert.equal(result.ok, true);
  assert.equal(result.values.firstName, "<b>Sam</b>"); // the page shows it with textContent
});

// ---------- the saved record ----------

test("a record is pending, priced from the nonprofit, and time-stamped", () => {
  const values = validateSponsor(good).values;
  const now = new Date("2026-11-13T15:00:00Z");
  const record = buildRecord(values, "rescue", rescue, bella, now, () => "id-1");
  assert.deepEqual(record, {
    id: "id-1", orgKey: "rescue", itemName: "Bella", firstName: "Sarah", email: "sarah@example.com",
    showName: true, businessName: null, monthly: 25, status: "pending", createdAt: "2026-11-13T15:00:00.000Z",
  });
});

test("a record without a nonprofit or item is refused", () => {
  assert.throws(() => buildRecord(good, "rescue", rescue, undefined), /something to follow/);
  assert.throws(() => buildRecord(good, "rescue", undefined, bella), /nonprofit/);
});

test("public name: business first, then first name if allowed, else anonymous", () => {
  assert.equal(publicName({ businessName: "Corner Cafe", firstName: "Jo", showName: false }), "Corner Cafe");
  assert.equal(publicName({ businessName: null, firstName: "Jo", showName: true }), "Jo");
  assert.equal(publicName({ businessName: null, firstName: "Jo", showName: false }), "A neighbor");
});

// ---------- thank-you, payment, totals ----------

test("thank-you is signed by what they follow and fits the nonprofit", () => {
  const dog = thankYou({ firstName: "Sarah" }, rescue, bella);
  assert.equal(dog.title, "Thanks, Sarah!");
  assert.equal(dog.signedBy, "Bella");
  assert.match(dog.body, /I'll send you my first update/);
  const program = thankYou({ firstName: "Dana" }, ORGS.youth, ORGS.youth.items[1]);
  assert.match(program.body, /our first update/);
  assert.match(program.body, /the whole club/);
});

test("payment link: only real https links, null in demo mode", () => {
  assert.equal(paymentUrl({ donateUrl: null }), null);
  assert.equal(paymentUrl({ donateUrl: "http://example.org/give" }), null);
  assert.equal(paymentUrl({ donateUrl: "javascript:alert(1)" }), null);
  assert.equal(paymentUrl({ donateUrl: "not a url" }), null);
  assert.equal(paymentUrl({ donateUrl: "https://www.zeffy.com/en-US/donation-form/abc" }), "https://www.zeffy.com/en-US/donation-form/abc");
});

test("a new sponsor adds the monthly price and one to that item only", () => {
  const after = withNewSponsor(rescue, "Bella");
  assert.equal(after.covered, rescue.covered + 25);
  assert.equal(after.items[0].sponsors, bella.sponsors + 1);
  assert.equal(after.items[1].sponsors, rescue.items[1].sponsors);
  assert.equal(rescue.covered, 950, "the original data isn't changed");
});

test("an unknown item still adds money but changes no card", () => {
  const after = withNewSponsor(rescue, "Nobody");
  assert.equal(after.covered, rescue.covered + 25);
  assert.deepEqual(after.items.map((i) => i.sponsors), rescue.items.map((i) => i.sponsors));
});

test("percent covered stays between 0 and 100", () => {
  assert.equal(percentCovered(950, 2000), 48);
  assert.equal(percentCovered(0, 2000), 0);
  assert.equal(percentCovered(5000, 2000), 100);
  assert.equal(percentCovered(100, 0), 0);
  assert.equal(percentCovered(-50, 2000), 0);
});

test("money and sponsor labels read naturally", () => {
  assert.equal(money(1600), "$1,600");
  assert.equal(money(25), "$25");
  assert.equal(money(1234567.6), "$1,234,568");
  assert.equal(sponsorLabel(1), "1 sponsor");
  assert.equal(sponsorLabel(0), "0 sponsors");
  assert.equal(sponsorLabel(12), "12 sponsors");
});

test("time ago reads naturally and handles odd times", () => {
  const now = new Date("2026-11-13T15:00:00Z");
  assert.equal(timeAgo("2026-11-13T14:59:30Z", now), "just now");
  assert.equal(timeAgo("2026-11-13T14:59:00Z", now), "1 minute ago");
  assert.equal(timeAgo("2026-11-13T14:55:00Z", now), "5 minutes ago");
  assert.equal(timeAgo("2026-11-13T12:00:00Z", now), "3 hours ago");
  assert.equal(timeAgo("2026-11-11T15:00:00Z", now), "2 days ago");
  assert.equal(timeAgo("2026-11-14T15:00:00Z", now), "just now");
  assert.equal(timeAgo("garbage", now), "just now");
});

// ---------- the demo data itself ----------

test("every demo nonprofit has the fields the page needs", () => {
  const needed = ["name", "price", "kind", "everyone", "headline", "items", "goal", "covered", "steps", "faq", "quote"];
  for (const [key, org] of Object.entries(ORGS)) {
    for (const field of needed) assert.ok(org[field] !== undefined, `${key} is missing ${field}`);
    assert.ok(["animal", "program"].includes(org.kind), `${key} kind`);
    assert.ok(org.items.length >= 3, `${key} needs at least 3 things to follow`);
    assert.equal(new Set(org.items.map((i) => i.name)).size, org.items.length, `${key} item names must be unique`);
  }
});
