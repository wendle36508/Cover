// Tests for docs/js/live.js (turning database rows into a sponsor page). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadLiveOrg, orgFromRows } from "../docs/js/live.js";

const nonprofit = {
  id: "np1", slug: "harbor-paws", name: "Harbor Paws Rescue", place: "Portland, Maine", kind: "animal",
  monthly_price_cents: 2500, monthly_goal_cents: 200000, page: { headline: "Sponsor a dog for $25 a month.", everyone: "every dog here" },
};
const items = [
  { id: "i1", name: "Bella", photo_url: "photos/dog-smile.jpg", badge: "Waiting 94 days", note: "Steals tennis balls." },
  { id: "i2", name: "Moose", photo_url: null, badge: null, note: null },
];

test("database rows become the page the sponsor page draws", () => {
  const org = orgFromRows(nonprofit, items, [{ item_id: "i1", sponsors: 3 }], 7500, [{ display_name: "Sarah", item_name: "Bella" }]);
  assert.equal(org.live, true);
  assert.equal(org.price, 25);
  assert.equal(org.goal, 2000);
  assert.equal(org.covered, 75);
  assert.equal(org.initials, "HP");
  assert.equal(org.headline, "Sponsor a dog for $25 a month.");
  assert.equal(org.everyone, "every dog here");
  assert.deepEqual(org.items.map((i) => [i.name, i.sponsors]), [["Bella", 3], ["Moose", 0]]);
  assert.equal(org.items[1].photo, "");
  assert.equal(org.recent[0].display_name, "Sarah");
});

test("a nonprofit that hasn't written page text still gets a sensible page", () => {
  const org = orgFromRows({ ...nonprofit, page: null, name: "Eastside Pantry" }, []);
  assert.equal(org.headline, "Sponsor Eastside Pantry for $25 a month.");
  assert.equal(org.steps.length, 3);
  assert.equal(org.covered, 0);
  assert.deepEqual(org.items, []);
});

test("counts arriving as text (from the database) are read as numbers", () => {
  const org = orgFromRows(nonprofit, items, [{ item_id: "i2", sponsors: "4" }], "2500");
  assert.equal(org.items[1].sponsors, 4);
  assert.equal(org.covered, 25);
});

test("page links that aren't valid are never sent to the database", async () => {
  for (const slug of ["", null, "Harbor Paws", "../x", "a;drop"]) assert.equal(await loadLiveOrg(slug), null);
});
