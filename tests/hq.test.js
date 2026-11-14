// Tests for docs/js/hq-logic.js (Cover HQ tiles and alerts). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { dollars, eventLabel, hqAlerts, hqTiles } from "../docs/js/hq-logic.js";

const base = { live_pages: 1, nonprofits: 2, active_sponsors: 5, monthly_cents: 12500, new_sponsors_7d: 2, card_failed: 0, needs_review: 0, pending_invites: 0, canceled_30d: 1 };

test("tiles show the headline numbers and flag problems in amber", () => {
  const tiles = hqTiles(base);
  assert.equal(tiles.find((t) => t.label === "Live pages").value, "1 of 2");
  assert.equal(tiles.find((t) => t.label === "Monthly giving").value, "$125");
  assert.equal(tiles.filter((t) => t.warn).length, 0);
  assert.equal(hqTiles({ ...base, card_failed: 2, needs_review: 1 }).filter((t) => t.warn).length, 2);
  assert.equal(hqTiles(undefined)[0].value, "0 of 0");
});

test("alerts walk each nonprofit through setup, worst first", () => {
  const data = {
    totals: { ...base, needs_review: 1, card_failed: 1 },
    nonprofits: [
      { name: "Invited Org", invite_pending: true, owner_joined: false, payouts_started: false, is_live: false, things_to_follow: 0, with_photos: 0 },
      { name: "Joined Org", invite_pending: false, owner_joined: true, payouts_started: false, is_live: false, things_to_follow: 3, with_photos: 1 },
      { name: "Waiting Org", owner_joined: true, payouts_started: true, is_live: false, things_to_follow: 2, with_photos: 2 },
      { name: "Empty Live Org", owner_joined: true, payouts_started: true, is_live: true, things_to_follow: 0, with_photos: 0 },
    ],
  };
  const alerts = hqAlerts(data);
  assert.equal(alerts[0].level, "bad");
  const text = alerts.map((a) => a.text).join(" | ");
  for (const expected of ["hasn't signed in", "hasn't started payouts", "waiting on verification", "nothing to follow", "2 without a photo", "card failed"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("no problems means all clear", () => {
  assert.deepEqual(hqAlerts({ totals: base, nonprofits: [] }), [{ level: "ok", text: "All clear. Nothing needs you right now." }]);
  assert.equal(hqAlerts(undefined)[0].level, "ok");
});

test("money and event names read naturally", () => {
  assert.equal(dollars(250000), "$2,500");
  assert.equal(dollars(null), "$0");
  assert.equal(eventLabel("charge.dispute.created"), "A donor disputed a charge");
  assert.equal(eventLabel("something.new"), "something.new");
});
