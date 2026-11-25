// Tests for docs/js/dashboard-logic.js (the numbers and checks behind the nonprofit dashboard). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RAW_PHOTO_MAX_BYTES, checklist, clampFocus, fitWithin, focusFromClick, nameFromFile, objectPosition, countsByItem, followedMost, greeting, monthStats, newestSponsors, photoPath,
  photoProblem, slugify, sponsorName, statusLabel, validateItem, validatePage, validateSignup, wallName, wallStatus, welcomeCandidates,
  welcomeCaption, welcomeFileName, welcomeHeadline, whenText, wrapLines,
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
    { covered: 0, goal: 0, percent: 0, activeCount: 0, newThisMonth: 0, businesses: 0, businessesNew: 0, sponsorsToGoal: 0, needsAttention: 0, oneTimeCount: 0, oneTimeCents: 0 },
  );
  assert.equal(monthStats([], 200000, NOW).sponsorsToGoal, 80); // assumes $25 gifts with no history
  const big = monthStats([{ status: "active", monthly_cents: 900000, created_at: "2026-11-01" }], 200000, NOW);
  assert.equal(big.percent, 100);
  assert.equal(big.sponsorsToGoal, 0);
});

test("newest sponsors leave out cancellations and show what they follow", () => {
  const rows = newestSponsors(sponsors, items, 3, NOW);
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

test("photo checks: any image type, up to 40 MB before shrinking", () => {
  assert.equal(photoProblem({ type: "image/jpeg", size: 1000 }), "");
  assert.equal(photoProblem({ type: "image/heic", size: 8_000_000 }), "");
  assert.match(photoProblem({ type: "application/pdf", size: 10 }), /isn't a photo/);
  assert.match(photoProblem({ type: "image/png", size: RAW_PHOTO_MAX_BYTES + 1 }), /40 MB/);
  assert.equal(photoProblem(null), "");
  assert.equal(photoPath("np1", { type: "image/jpeg" }, "abc"), "np1/abc.jpg");
});

test("photos shrink so the longest side is 1600, never enlarging", () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 1), { width: 1600, height: 1 });
  assert.throws(() => fitWithin(0, 100), /width and height/);
});

test("names come from file names, ignoring camera names", () => {
  assert.equal(nameFromFile("bella.jpg"), "Bella");
  assert.equal(nameFromFile("big_moose-2.JPEG"), "Big Moose");
  assert.equal(nameFromFile("IMG_4821.HEIC"), "");
  assert.equal(nameFromFile("PXL_20261113_101500.jpg"), "");
  assert.equal(nameFromFile("Screenshot 2026-11-13 at 9.41.12 AM.png"), "At Am");
  assert.equal(nameFromFile(undefined), "");
});

test("crop points stay inside the photo", () => {
  assert.deepEqual(clampFocus(20.4, 77.6), { x: 20, y: 78 });
  assert.deepEqual(clampFocus(-5, 140), { x: 0, y: 100 });
  assert.deepEqual(clampFocus("bad", null), { x: 50, y: 0 });
  assert.deepEqual(focusFromClick(100, 50, 400, 200), { x: 25, y: 25 });
  assert.deepEqual(focusFromClick(5, 5, 0, 0), { x: 50, y: 38 });
  assert.equal(objectPosition({ photo_focus_x: 10, photo_focus_y: 90 }), "10% 90%");
  assert.equal(objectPosition({}), "50% 38%");
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

test("the Mark adopted message says what happened", async () => {
  const { finishSummary } = await import("../docs/js/dashboard-logic.js");
  assert.equal(finishSummary("Bella", { moved: 0 }), "Bella marked finished.");
  assert.equal(finishSummary("Bella", { moved: 3, emailed: 2, muted: 1, failed: 0, emailsOn: true }), "Bella marked finished. 2 sponsors got the news and can pick a new buddy.");
  assert.match(finishSummary("Bella", { moved: 1, emailed: 0, emailsOn: false }), /Emails aren't switched on yet/);
  assert.equal(finishSummary("Bella", { moved: 3, emailed: 0, queued: 3, emailsOn: true }), "Bella marked finished. Cover has sent a lot of email today, so 3 sponsors get the news tomorrow morning.");
  assert.match(finishSummary("Bella", { moved: 2, emailed: 1, failed: 1, emailsOn: true }), /1 email didn't send/);
});

test("who an update reaches, and what the owner is told", async () => {
  const { updateAudience, postSummary } = await import("../docs/js/dashboard-logic.js");
  const sponsors = [
    { item_id: "bella", status: "active", updates_off: false },
    { item_id: "bella", status: "past_due", updates_off: false },
    { item_id: "bella", status: "active", updates_off: true },
    { item_id: "bella", status: "canceled", updates_off: false },
    { item_id: "max", status: "active", updates_off: false },
  ];
  assert.equal(updateAudience(sponsors, "bella"), 2);
  assert.equal(updateAudience([], "bella"), 0);
  assert.equal(postSummary("Bella", { sent: true, emailed: 2, sponsors: 2, emailsOn: true }), "Update sent to 2 sponsors.");
  assert.match(postSummary("Bella", { sent: false, deferred: true, scheduledFor: "2026-12-02T14:00:00Z" }), /^Update saved\. Cover has sent a lot of email today, so this one goes out Wednesday morning\.$/);
  assert.match(postSummary("Bella", { sent: true, emailed: 0, sponsors: 0, emailsOn: true }), /no sponsors with updates on yet/);
  assert.equal(postSummary("Bella", { sent: false, scheduledFor: "2026-11-16T14:00:00Z" }), "You already sent an update about Bella today, so this one goes out Monday at 9am.");
});

test("thank-you wall column: private unless they opted in, and the owner can hide or show", () => {
  assert.deepEqual(wallStatus({ show_name: false }), { tone: "off", text: "Private", button: null, hide: null });
  assert.deepEqual(wallStatus({ show_name: true, wall_hidden: false }), { tone: "active", text: "On the wall", button: "Hide", hide: true });
  assert.deepEqual(wallStatus({ show_name: true, wall_hidden: true }), { tone: "late", text: "Hidden by you", button: "Show", hide: false });
  assert.equal(wallStatus(undefined).text, "Private");
});

test("wall name matches what the page shows", () => {
  assert.equal(wallName({ first_name: "Sarah", last_initial: "K" }), "Sarah K.");
  assert.equal(wallName({ first_name: "Sarah", last_initial: null }), "Sarah");
  assert.equal(wallName({ first_name: "Jo", business_name: "Corner Cafe", last_initial: "K" }), "Corner Cafe");
  assert.equal(wallName(null), "");
});

// ---------- welcome post ----------

test("welcome post: only recent, active, opted-in, not-hidden sponsors who follow something, newest first", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const day = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const things = [{ id: "i1", name: "Bella" }, { id: "i2", name: "Max" }];
  const base = { status: "active", show_name: true, wall_hidden: false, item_id: "i1" };
  const sponsors = [
    { ...base, id: "a", first_name: "Old", created_at: day(20) },
    { ...base, id: "b", first_name: "Sarah", created_at: day(1) },
    { ...base, id: "c", first_name: "Quiet", show_name: false, created_at: day(0) },
    { ...base, id: "d", first_name: "Hid", wall_hidden: true, created_at: day(0) },
    { ...base, id: "e", first_name: "Late", status: "past_due", created_at: day(0) },
    { ...base, id: "f", first_name: "Jo", business_name: "Corner Cafe", item_id: "i2", created_at: day(0.5) },
    { ...base, id: "g", first_name: "Nobody", item_id: null, created_at: day(0) },
  ];
  const picks = welcomeCandidates(sponsors, things, now);
  assert.deepEqual(picks.map((p) => [p.greet, p.item.name]), [["Corner Cafe", "Max"], ["Sarah", "Bella"]]);
  assert.deepEqual(welcomeCandidates([], things, now), []);
  assert.deepEqual(welcomeCandidates(undefined, undefined, now), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...base, id: `m${i}`, first_name: `P${i}`, created_at: day(i / 10) }));
  assert.equal(welcomeCandidates(many, things, now).length, 5);
});

test("welcome post words fit animals and programs and end with the page link", () => {
  assert.equal(welcomeHeadline("Sarah", "Bella"), "Welcome Sarah, Bella's newest sponsor!");
  const dog = welcomeCaption({ greet: "Sarah", itemName: "Bella", nonprofitName: "Harbor Paws", kind: "animal", link: "https://covergiving.com/give.html?org=harbor-paws" });
  assert.match(dog, /^Welcome Sarah, Bella's newest sponsor! Thank you for helping Bella \(and every animal at Harbor Paws\)/);
  assert.ok(dog.endsWith("Want to sponsor a buddy too? https://covergiving.com/give.html?org=harbor-paws"));
  const program = welcomeCaption({ greet: "Dana", itemName: "Art Studio", nonprofitName: "Eastside Youth", kind: "program", link: "L" });
  assert.match(program, /keep Art Studio \(and everything at Eastside Youth\) going/);
  assert.ok(program.endsWith("Want to sponsor too? L"));
});

test("headline wraps to fit the image width", () => {
  const measure = (text) => text.length * 10;
  assert.deepEqual(wrapLines("Welcome Sarah, Bella's newest sponsor!", 160, measure), ["Welcome Sarah,", "Bella's newest", "sponsor!"]);
  assert.deepEqual(wrapLines("Supercalifragilistic hi", 50, measure), ["Supercalifragilistic", "hi"]);
  assert.deepEqual(wrapLines("", 100, measure), []);
});

test("download file names are safe", () => {
  assert.equal(welcomeFileName("Sarah", "Bella"), "welcome-sarah-bella.png");
  assert.equal(welcomeFileName("Corner Café!", "Art Studio"), "welcome-corner-cafe-art-studio.png");
  assert.equal(welcomeFileName("../..", ""), "welcome-sponsor.png");
});

// ---------- one-time gifts (bug found by Tanner, Nov 25, 2026) ----------

test("one-time gifts are counted on their own, never as monthly money", async () => {
  const { listedSponsors } = await import("../docs/js/dashboard-logic.js");
  const withOnce = [
    ...sponsors,
    { item_id: "i1", status: "gave_once", interval: "once", amount_cents: 1000, monthly_cents: 1000, created_at: "2026-11-20T12:00:00", first_name: "Tanner" },
    { item_id: "i1", status: "gave_once", interval: "once", amount_cents: 5000, monthly_cents: 5000, created_at: "2026-10-20T12:00:00", first_name: "Old" },
  ];
  const stats = monthStats(withOnce, 200000, NOW);
  assert.equal(stats.oneTimeCount, 1, "only this month's");
  assert.equal(stats.oneTimeCents, 1000);
  assert.equal(stats.covered, 150, "monthly money is unchanged by one-time gifts");
  assert.equal(stats.activeCount, 3);
  const rows = newestSponsors(withOnce, items, 2, NOW);
  assert.deepEqual(rows.map((r) => [r.name, r.label.text]), [["Pat", "Waiting on payment"], ["Tanner", "Gave once"]]);
  const later = new Date("2026-11-20T16:30:00");
  assert.ok(!listedSponsors(withOnce, later).some((s) => s.first_name === "Pat"), "a card form closed over an hour ago isn't a sponsor");
  assert.ok(listedSponsors(withOnce, later).some((s) => s.first_name === "Tanner"));
  assert.ok(!listedSponsors(withOnce, later).some((s) => s.status === "canceled"));
});
