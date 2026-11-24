// Tests for the homepage's live nonprofits section: only working cards, "Sponsor a dog" wording,
// links, and one featured card vs a grid. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanNonprofits, layoutFor, pageLink, sponsorLine } from "../docs/js/home-nonprofits-logic.js";

const LUCKY = {
  slug: "lucky-pup-rescue", name: "Lucky Pup Rescue", place: null, kind: "animal", nav_label: "Dogs", template: null,
  logo: "https://x.supabase.co/logo.png", cover_photo: "https://x.supabase.co/cover.jpg", headline: "Not every pup is lucky.",
  items: [{ name: "Burt", photo_url: "https://x.supabase.co/burt.jpg", focus_x: 25, focus_y: 22 }, { name: "No photo", photo_url: null }],
};

test("one live nonprofit gets a featured card; more get a grid; none hides the section", () => {
  assert.equal(layoutFor(0), "hidden");
  assert.equal(layoutFor(1), "featured");
  assert.equal(layoutFor(3), "grid");
});

test("cards only from rows that work, with nothing blank", () => {
  const [lucky] = cleanNonprofits([LUCKY, { slug: "Bad Slug!", name: "x" }, { slug: "no-name", name: " " }, null]);
  assert.equal(cleanNonprofits([LUCKY, { slug: "Bad Slug!", name: "x" }]).length, 1);
  assert.equal(lucky.place, "", "no town: none shown");
  assert.deepEqual(lucky.items, [{ name: "Burt", photo: "https://x.supabase.co/burt.jpg", focus: "25% 22%" }], "dogs without photos are left out");
  assert.equal(cleanNonprofits([{ ...LUCKY, logo: "javascript:alert(1)" }])[0].logo, "", "only safe image links");
  assert.deepEqual(cleanNonprofits("nope"), []);
});

test("wording and links", () => {
  const [lucky] = cleanNonprofits([LUCKY]);
  assert.equal(sponsorLine(lucky), "Sponsor a dog");
  assert.equal(sponsorLine(cleanNonprofits([{ slug: "pantry-one", name: "Pantry", kind: "program", template: "food" }])[0]), "Sponsor a program");
  assert.equal(pageLink(lucky), "give.html?org=lucky-pup-rescue");
  assert.equal(pageLink(lucky, "Burt"), "give.html?org=lucky-pup-rescue&dog=Burt");
});
