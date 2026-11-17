// Tests for docs/js/hq-logic.js (Cover HQ tiles and alerts). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { dollars, einCheckText, eventLabel, hqAlerts, hqTiles, sourceRow, STALE_DAYS, validateBenchmark } from "../docs/js/hq-logic.js";

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

// ---------- nonprofit data panel ----------

test("source rows say up to date, out of date, failed, running or never run", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  const done = (daysAgo) => ({ source: "irs_bmf", status: "done", rows_loaded: 1234480, file_date: "2026-11-09", finished_at: new Date(now - daysAgo * 86400000).toISOString() });
  const fresh = sourceRow(done(5), now);
  assert.equal(fresh.name, "IRS registry (BMF)");
  assert.equal(fresh.rows, "1,234,480");
  assert.deepEqual(fresh.status, { text: "Up to date", tone: "ok" });
  assert.deepEqual(sourceRow(done(STALE_DAYS + 1), now).status, { text: "Out of date", tone: "warn" });
  assert.deepEqual(sourceRow({ source: "irs_990n", status: "failed", note: "boom" }, now).status, { text: "Failed", tone: "bad" });
  assert.deepEqual(sourceRow({ source: "irs_pub78", status: "running" }, now).status, { text: "Running", tone: "ok" });
  const never = sourceRow({ source: "irs_revocations", status: "never" }, now);
  assert.deepEqual([never.status.text, never.lastRun, never.fileDate], ["Never run", "—", "—"]);
  assert.equal(sourceRow(undefined, now).name, "");
});

test("EIN check results read in plain English", () => {
  assert.match(einCheckText({ status: "good", name: "HARBOR PAWS", city: "PORTLAND", state: "ME" }).text, /^HARBOR PAWS \(PORTLAND, ME\) is a 501\(c\)\(3\) in good standing/);
  assert.equal(einCheckText({ status: "revoked", ein: "000000002", revoked_on: "2020-05-15" }).tone, "bad");
  assert.match(einCheckText({ status: "not_in_pub78", name: "X" }).text, /may not be tax-deductible/);
  assert.match(einCheckText({ status: "not_found", ein: "123456789" }).text, /isn't in the IRS registry/);
  assert.match(einCheckText({ status: "bad_ein" }).text, /9 digits/);
  assert.equal(einCheckText(null).tone, "bad");
});

test("benchmark edits need a real https link, a date and every field", () => {
  const good = { id: "fep_retention_ytd", label: "Retention", value: "27%", definition: "d", source_name: "FEP", source_url: "https://x.org", as_of: "2027-01-28", sort_order: "10" };
  const ok = validateBenchmark(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.values.sort_order, 10);
  const bad = validateBenchmark({ ...good, source_url: "javascript:alert(1)", as_of: "Jan 28", value: " ", id: "Bad!" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["as_of", "id", "source_url", "value"]);
  assert.equal(validateBenchmark(undefined).ok, false);
});
