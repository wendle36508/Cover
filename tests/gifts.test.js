// Tests for docs/js/gifts-logic.js (the My gifts page's formatting, checks and demo). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  demoGifts, followLine, helpsLine, money, monthYear, pickToken, readDollars, shortDate, statusInfo,
} from "../docs/js/gifts-logic.js";

test("money and dates read naturally", () => {
  assert.equal(money(2500), "$25");
  assert.equal(money(3050), "$30.50");
  assert.equal(money(100000), "$1,000");
  assert.equal(money(undefined), "$0");
  assert.equal(shortDate("2026-12-03T12:00:00Z"), "Dec 3, 2026");
  assert.equal(shortDate(null), "");
  assert.equal(shortDate("not a date"), "");
  assert.equal(monthYear("2026-11-15T12:00:00Z"), "November 2026");
});

test("status pills", () => {
  assert.deepEqual(statusInfo("active"), { label: "Active", tone: "green" });
  assert.deepEqual(statusInfo("past_due"), { label: "Card didn't go through", tone: "warn" });
  assert.equal(statusInfo("canceled").label, "Ended");
  assert.equal(statusInfo("something new").label, "Ended");
});

test("who they follow, in present or past tense", () => {
  const np = { name: "Harbor Paws", kind: "animal" };
  assert.equal(followLine({ canChange: true, following: { name: "Bella" }, nonprofit: np }), "You follow Bella");
  assert.equal(followLine({ canChange: true, following: null, nonprofit: np }), "You support everyone at Harbor Paws");
  assert.equal(followLine({ canChange: false, following: { name: "Bella" }, nonprofit: np }), "You followed Bella");
  assert.equal(helpsLine({ canChange: true, nonprofit: np }), "Your gift helps every animal at Harbor Paws.");
  assert.equal(helpsLine({ canChange: false, nonprofit: { name: "Pantry", kind: "program" } }), "Your gifts helped everything at Pantry. Thank you.");
});

test("the amount box checks dollars the same way the server does", () => {
  assert.deepEqual(readDollars("25"), { cents: 2500 });
  assert.deepEqual(readDollars("$7.5"), { cents: 750 });
  assert.match(readDollars("4").error, /smallest/);
  assert.match(readDollars("1001").error, /largest/);
  assert.match(readDollars("ten").error, /like 25/);
  assert.match(readDollars("").error, /like 25/);
});

test("the token comes from the link first, then this tab's memory", () => {
  assert.deepEqual(pickToken("?t=abc", "old"), { token: "abc", fromLink: true });
  assert.deepEqual(pickToken("", "old"), { token: "old", fromLink: false });
  assert.deepEqual(pickToken("?demo=1", null), { token: "", fromLink: false });
});

test("the demo has a working gift and one whose card failed, with only the site's own photos", () => {
  const { gifts } = demoGifts();
  assert.deepEqual(gifts.map((g) => g.status), ["active", "past_due"]);
  for (const gift of gifts) {
    for (const url of [gift.following?.photoUrl, ...gift.choices.map((c) => c.photoUrl)]) assert.match(url, /^photos\/[\w-]+\.jpg$/);
  }
});

// ---------- My sponsorships (Nov 25, 2026) ----------

test("My sponsorships: the summary line under Hi Sarah", async () => {
  const { summaryLine } = await import("../docs/js/gifts-logic.js");
  const np = { name: "Lucky Pup Rescue", kind: "animal", one: "dog" };
  const falkor = { canChange: true, interval: "month", giftCents: 2500, following: { name: "Falkor" }, nonprofit: np };
  const becky = { ...falkor, giftCents: 1000, following: { name: "Becky" } };
  assert.equal(summaryLine([falkor, becky]), "You sponsor 2 dogs at Lucky Pup Rescue, $35 a month in all. Thank you.");
  assert.equal(summaryLine([falkor]), "You sponsor Falkor at Lucky Pup Rescue, $25 a month. Thank you.");
  assert.equal(summaryLine([falkor, { ...becky, interval: "year", giftCents: 30000 }]), "You sponsor 2 dogs at Lucky Pup Rescue. Thank you.", "no total when one is yearly");
  const pantry = { canChange: true, interval: "month", giftCents: 1500, following: null, nonprofit: { name: "Pantry", kind: "program", one: "program" } };
  assert.equal(summaryLine([falkor, pantry]), "You have 2 sponsorships at 2 nonprofits, $40 a month in all. Thank you.");
  assert.equal(summaryLine([{ ...falkor, canChange: false }]), "Thank you for everything you've given.");
});

test("My sponsorships: time together, amounts, and the updates and receipts lists", async () => {
  const { amountLabel, giftName, paymentsFeed, togetherLabel, updatesFeed } = await import("../docs/js/gifts-logic.js");
  const now = new Date("2026-12-02T15:00:00Z");
  assert.equal(togetherLabel("2026-11-25T10:00:00Z", now), "1 week");
  assert.equal(togetherLabel("2026-10-02T10:00:00Z", now), "2 months");
  assert.equal(togetherLabel("", now), "");
  assert.equal(amountLabel({ giftCents: 30000, interval: "year" }), "$300 a year");
  assert.equal(amountLabel({ monthlyCents: 2500 }), "$25 a month");
  const np = { name: "Lucky Pup Rescue" };
  const gifts = [
    { following: { name: "Falkor", photoUrl: "https://x/f.jpg" }, nonprofit: np, updates: [{ date: "2026-11-01T00:00:00Z", text: "a" }, { date: "2026-12-01T00:00:00Z", text: "c" }],
      payments: [{ date: "2026-11-01T00:00:00Z", amountCents: 2500 }] },
    { following: null, nonprofit: np, updates: [{ date: "2026-11-15T00:00:00Z", text: "b" }], payments: [{ date: "2026-11-20T00:00:00Z", amountCents: 1000 }] },
  ];
  assert.equal(giftName(gifts[1]), "Lucky Pup Rescue");
  assert.deepEqual(updatesFeed(gifts).map((u) => u.text), ["c", "b", "a"], "newest first, across every gift");
  assert.equal(updatesFeed(gifts)[0].fallbackPhoto, "https://x/f.jpg");
  assert.deepEqual(paymentsFeed(gifts).map((p) => p.name), ["Lucky Pup Rescue", "Falkor"]);
  assert.equal(updatesFeed(gifts, 1).length, 1);
});

test("the sign-in's robot check really loads (its box isn't named 'turnstile', which hid the real check)", () => {
  const js = readFileSync(new URL("../docs/js/gifts.js", import.meta.url), "utf8");
  assert.match(js, /bot\.id = "gifts-turnstile";/);
  assert.match(js, /if \(typeof globalThis\.turnstile\?\.render === "function"\) return resolve\(\);/);
  assert.doesNotMatch(js, /bot\.id = "turnstile"/);
});
