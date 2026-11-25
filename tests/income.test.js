// income.test.js - the owner dashboard's income chart (Nov 25, 2026): real payments by month.

import { test } from "node:test";
import assert from "node:assert/strict";

import { incomeByMonth, incomeSince, recentMonths } from "../supabase/functions/_shared/income.js";
import { readAction } from "../supabase/functions/_shared/connect.js";

const NOW = new Date("2026-11-25T18:00:00Z");
const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const paid = (iso, cents, extra = {}) => ({ status: "succeeded", paid: true, amount: cents, amount_refunded: 0, created: at(iso), metadata: {}, ...extra });

test("the chart covers the last 12 months, oldest first, ending this month", () => {
  const months = recentMonths(NOW);
  assert.equal(months.length, 12);
  assert.deepEqual(months[0], { key: "2025-12", label: "Dec", year: 2025 });
  assert.deepEqual(months[11], { key: "2026-11", label: "Nov", year: 2026 });
  assert.equal(recentMonths(new Date("2027-01-10T12:00:00Z"))[10].key, "2026-12", "crosses the new year");
  assert.ok(incomeSince(NOW) <= at("2025-12-01T00:00:00Z"), "asks Stripe from before the oldest month");
});

test("real payments count, by month, with sponsorships and one-time gifts kept apart", () => {
  const charges = [
    paid("2026-11-25T16:02:00Z", 1000, { metadata: { cover_sponsor_id: "s1" } }), // Tanner's $10 one-time gift
    paid("2026-11-03T15:00:00Z", 2500),                                              // a monthly sponsorship payment
    paid("2026-10-03T15:00:00Z", 2500),
    paid("2026-10-15T15:00:00Z", 5000, { amount_refunded: 2000 }),                   // partly refunded
    paid("2026-10-20T15:00:00Z", 900, { amount_refunded: 900 }),                     // fully refunded: nothing
    { ...paid("2026-11-10T15:00:00Z", 4000), status: "failed", paid: false },        // card failed: nothing
    paid("2024-01-01T15:00:00Z", 9999),                                              // too old for the chart
  ];
  const income = incomeByMonth(charges, NOW);
  const nov = income.months[11];
  const oct = income.months[10];
  assert.equal(nov.sponsorCents, 2500);
  assert.equal(nov.oneTimeCents, 1000);
  assert.equal(nov.totalCents, 3500);
  assert.equal(oct.sponsorCents, 2500 + 3000);
  assert.equal(oct.oneTimeCents, 0);
  assert.equal(income.thisMonthCents, 3500);
  assert.equal(income.totalCents, 3500 + 5500);
});

test("months are counted in Eastern time", () => {
  // 11:30pm Eastern on Oct 31 is Nov 1 in UTC, but it's October's money.
  const income = incomeByMonth([paid("2026-11-01T03:30:00Z", 2500)], NOW);
  assert.equal(income.months[10].totalCents, 2500, "October");
  assert.equal(income.months[11].totalCents, 0);
});

test("no payments yet: twelve empty months, never an error", () => {
  const income = incomeByMonth([], NOW);
  assert.equal(income.months.length, 12);
  assert.ok(income.months.every((m) => m.totalCents === 0));
  assert.equal(incomeByMonth(undefined, NOW).totalCents, 0);
});

test("the dashboard may ask for its income", () => {
  assert.equal(readAction({ action: "income" }), "income");
  assert.throws(() => readAction({ action: "charges" }), /Unknown action/);
});
