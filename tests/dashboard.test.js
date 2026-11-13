// Tests for docs/js/dashboard-logic.js (the numbers and checks behind the nonprofit dashboard). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHOTO_MAX_BYTES, checklist, countsByItem, followedMost, greeting, monthStats, newestSponsors, photoPath,
  photoProblem, slugify, sponsorName, statusLabel, validateItem, validatePage, validateSignup, whenText,
} from "../docs/js/dashboard-logic.js";

const NOW = new Date("2026-11-20T15:00:00");
const items = [
  { id: "i1", name: "Bella", status: "active", photo_url: "https://x/bella.jpg" },
  { id: "i2", name: "Moose", status: "active", photo_url: null },
  { id: "i3", name: "Tilly", status: "finished", photo_url: "https://x/tilly.jpg" },
];
const sponsors = [
  { item_id: "i1", status: "active", monthly_cents: 2500, created_at: "2026-11-19T10:00:00", first_name: "Sarah", business_name: null },
  { item_id: "i1", status: "active", monthly_cents: 2500, created_at: "2026-10-02T10:00:00", first_name: "Jon", business_name: null },
  { item_id: "i2", status: "active", monthly_cents: 10000, created_at: "2026-11-03T10:00:00", first_name: "Ann", business_name: "Bay Street Hardware" },
  { item_id: "i2", status: "past_due", monthly_cents: 2500, created_at: "2026-09-01T10:00:00", first_name: "Ana", business_name: null },
  { item_id: "i1", status: "pending", monthly_cents: 2500, created_at: "2026-11-20T14:59:00", first_name: "Pat", business_name: null },
  { item_id: "i1", status: "canceled", monthly_cents: 2500, created_at: "2026-11-20T14:00:00", first_name: "Lee", business_name: null },
];

test("page links come from names", () => {
  assert.equal(slugify("Harbor Paws Rescue!"), "harbor-paws-rescue");
  assert.equal(slugify("  Café & Friends  "), "cafe-and-friends");
  assert.equal(slugify("---"), "");
  assert.equal(slugify("x".repeat(80)).length, 60);
  assert.equal(slugify(null), "");
});

test("greeting follows the time of day", () => {
  assert.equal(greeting(new Date("2026-11-20T09:00:00")), "Good morning");
  assert.equal(greeting(new Date("2026-11-20T13:00:00")), "Good afternoon");
  assert.equal(greeting(new Date("2026-11-20T20:00:00")), "Good evening");
});

test("this month's numbers count active sponsors only", () => {
  const stats = monthStats(sponsors, 200000, NOW);
  assert.equal(stats.covered, 150);
  assert.equal(stats.goal, 2000);
  assert.equal(stats.percent, 8);
  assert.equal(stats.activeCount, 3);
  assert.equal(stats.newThisMonth, 2);
  assert.equal(stats.businesses, 1);
  assert.equal(stats.businessesNew, 1);
  assert.equal(stats.needsAttention, 1);
  assert.equal(stats.sponsorsToGoal, 37); // $1,850 left at an average of $50
});

test("monthly numbers handle no sponsors, no goal, and goals already reached", () => {
  assert.deepEqual(
    { ...monthStats([], 0, NOW) },
    { covered: 0, goal: 0, percent: 0, activeCount: 0, newThisMonth: 0, businesses: 0, businessesNew: 0, sponsorsToGoal: 0, needsAttention: 0 },
  );
  assert.equal(monthStats([], 200000, NOW).sponsorsToGoal, 80); // assumes $25 gifts with no history
  const big = monthStats([{ status: "active", monthly_cents: 900000, created_at: "2026-11-01" }], 200000, NOW);
  assert.equal(big.percent, 100);
  assert.equal(big.sponsorsToGoal, 0);
});

test("newest sponsors leave out cancellations and show what they follow", () => {
  const rows = newestSponsors(sponsors, items, 3);
  assert.deepEqual(rows.map((r) => [r.name, r.following, r.label.text]), [
    ["Pat", "Bella", "Waiting on payment"],
    ["Sarah", "Bella", "Active"],
    ["Bay Street Hardware", "Moose", "Active"],
  ]);
  assert.equal(newestSponsors([{ status: "active", created_at: NOW, first_name: "X", item_id: "gone" }], items)[0].following, "—");
});

test("followed most ranks active items by active sponsors", () => {
  assert.deepEqual(followedMost(items, sponsors).map((i) => [i.name, i.sponsors]), [["Bella", 2], ["Moose", 1]]);
  assert.equal(countsByItem(sponsors).get("i1"), 2);
});

test("status labels and sponsor names read naturally", () => {
  assert.equal(statusLabel("past_due").text, "Card failed");
  assert.equal(statusLabel("something_new").text, "Waiting on payment");
  assert.equal(sponsorName({ first_name: "Ann", business_name: "Bay Street Hardware" }), "Bay Street Hardware");
});

test("the checklist ticks off as the nonprofit sets up", () => {
  const fresh = checklist({ nonprofit: { is_live: false, page: { navLabel: "Dogs" } }, items: [], linkShared: false });
  assert.equal(fresh.done, 1);
  assert.equal(fresh.steps[2].text, "Add dogs people can follow");
  const ready = checklist({ nonprofit: { is_live: true, page: {} }, items: items.filter((i) => i.photo_url), linkShared: true });
  assert.equal(ready.done, 5);
  const missingPhoto = checklist({ nonprofit: { is_live: true, page: {} }, items, linkShared: false });
  assert.equal(missingPhoto.steps.find((s) => s.key === "photos").done, false);
});

test("thing-to-follow form checks", () => {
  assert.equal(validateItem({ name: "  Bella  ", badge: "Waiting 94 days", note: "Steals balls." }).ok, true);
  assert.equal(validateItem({ name: "  Bella  " }).values.name, "Bella");
  assert.match(validateItem({}).errors.name, /Add a name/);
  assert.match(validateItem({ name: "x".repeat(81) }).errors.name, /80/);
  assert.match(validateItem({ name: "ok", badge: "x".repeat(41) }).errors.badge, /40/);
  assert.match(validateItem({ name: "ok", note: "x".repeat(201) }).errors.note, /200/);
});

test("photo checks: type and size", () => {
  assert.equal(photoProblem({ type: "image/jpeg", size: 1000 }), "");
  assert.match(photoProblem({ type: "image/gif", size: 1000 }), /JPG/);
  assert.match(photoProblem({ type: "application/pdf", size: 10 }), /JPG/);
  assert.match(photoProblem({ type: "image/png", size: PHOTO_MAX_BYTES + 1 }), /5 MB/);
  assert.equal(photoProblem(null), "");
  assert.equal(photoPath("np1", { type: "image/png" }, "abc"), "np1/abc.png");
});

test("your-page form checks, with money typed in dollars", () => {
  const good = validatePage({ name: "Harbor Paws", headline: "Sponsor a dog", lead: "", navLabel: "Dogs", everyone: "every dog here", price: "25", goal: "2000" });
  assert.equal(good.ok, true);
  assert.equal(good.values.priceCents, 2500);
  assert.equal(good.values.goalCents, 200000);
  const bad = validatePage({ name: "H", navLabel: "D", price: "1", goal: "abc", headline: "x".repeat(91) });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["goal", "headline", "name", "navLabel", "price"]);
});

test("create-your-nonprofit form checks", () => {
  const good = validateSignup({ name: "Harbor Paws Rescue", slug: "Harbor-Paws", kind: "animal", followLabel: "Dogs", price: "25", goal: "2000" });
  assert.equal(good.ok, true);
  assert.equal(good.values.slug, "harbor-paws");
  assert.equal(validateSignup({ ...good.values, kind: "plants", price: 25, goal: 2000, followLabel: "Programs", slug: "ok-link", name: "Org" }).values.kind, "program");
  const bad = validateSignup({ name: "", slug: "no", followLabel: "", price: "0", goal: "" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["followLabel", "goal", "name", "price", "slug"]);
});

test("when-text for the tables", () => {
  assert.equal(whenText("2026-11-20T14:59:30", NOW), "Just now");
  assert.equal(whenText("2026-11-20T14:30:00", NOW), "30 min ago");
  assert.equal(whenText("2026-11-20T10:00:00", NOW), "5 hours ago");
  assert.equal(whenText("2026-11-19T10:00:00", NOW), "Yesterday");
  assert.equal(whenText("2026-11-02T10:00:00", NOW), "Nov 2");
});
