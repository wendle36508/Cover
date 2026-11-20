// Tests for docs/js/gifts-logic.js (the My gifts page's formatting, checks and demo). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

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
