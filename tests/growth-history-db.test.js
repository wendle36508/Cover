// Tests for the growth-history migration: every sponsor status change is logged, daily numbers
// leave out test pages, and only Cover admins can read any of it. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const ADMIN = "44444444-4444-4444-4444-444444444444";
const OWNER = "11111111-1111-1111-1111-111111111111";

let db;
let realNp;
let testNp;
let sponsor;

const today = async () => (await db.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d;
const metricsToday = async () => {
  await db.query("select public.record_daily_metrics()");
  return (await db.query("select * from public.daily_metrics where day = $1::date", [await today()])).rows[0];
};

before(async () => {
  db = await freshDatabase();
  realNp = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('real-rescue', 'Real Rescue', 'animal', true) returning id")).rows[0].id;
  testNp = (await db.query("insert into public.nonprofits (slug, name, is_live, is_test) values ('practice', 'Practice', true, true) returning id")).rows[0].id;
  const item = (await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Bella') returning id", [realNp])).rows[0].id;
  await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Fake')", [testNp]);
  sponsor = (await db.query(
    "insert into public.sponsors (nonprofit_id, item_id, first_name, email, monthly_cents, status) values ($1, $2, 'Ann', 'Ann@Example.com', 2500, 'pending') returning id",
    [realNp, item],
  )).rows[0].id;
  await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'Fake', 'fake@example.com', 9900, 'active')", [testNp]);
  await db.query("insert into auth.users (id) values ($1), ($2)", [ADMIN, OWNER]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [ADMIN]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner')", [OWNER, realNp]);
});

after(async () => {
  await db?.close();
});

test("every status change is logged, and saving without a change adds nothing", async () => {
  await db.query("update public.sponsors set status = 'active' where id = $1", [sponsor]);
  await db.query("update public.sponsors set first_name = 'Annie' where id = $1", [sponsor]);
  await db.query("update public.sponsors set status = 'past_due' where id = $1", [sponsor]);
  const { rows } = await db.query("select from_status, to_status, monthly_cents from public.sponsor_status_changes where sponsor_id = $1 order by id", [sponsor]);
  assert.deepEqual(rows, [
    { from_status: null, to_status: "pending", monthly_cents: 2500 },
    { from_status: "pending", to_status: "active", monthly_cents: 2500 },
    { from_status: "active", to_status: "past_due", monthly_cents: 2500 },
  ]);
});

test("daily numbers count real nonprofits only", async () => {
  await db.query("update public.sponsors set status = 'active' where id = $1", [sponsor]);
  const m = await metricsToday();
  assert.equal(m.nonprofits, 1);
  assert.equal(m.live_pages, 1);
  assert.equal(m.active_sponsors, 1);
  assert.equal(m.unique_donors, 1);
  assert.equal(Number(m.monthly_cents), 2500, "the test page's $99 sponsor is left out");
  assert.equal(m.new_sponsors, 1);
  assert.equal(m.things_to_follow, 1);
});

test("a cancel shows up the same day, and re-running just refreshes the row", async () => {
  await db.query("update public.sponsors set status = 'canceled' where id = $1", [sponsor]);
  const m = await metricsToday();
  assert.equal(m.canceled_sponsors, 1);
  assert.equal(m.active_sponsors, 0);
  assert.equal((await db.query("select count(*)::int as n from public.daily_metrics")).rows[0].n, 1);
});

test("only Cover admins can read growth data; nobody can write it from a browser", async () => {
  assert.equal((await runAs(db, "authenticated", ADMIN, "select * from public.daily_metrics")).rows.length, 1);
  assert.ok((await runAs(db, "authenticated", ADMIN, "select * from public.sponsor_status_changes")).rows.length >= 4);
  assert.equal((await runAs(db, "authenticated", OWNER, "select * from public.daily_metrics")).rows.length, 0);
  assert.equal((await runAs(db, "authenticated", OWNER, "select * from public.sponsor_status_changes")).rows.length, 0);
  await assert.rejects(runAs(db, "anon", null, "select * from public.daily_metrics"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", ADMIN, "delete from public.daily_metrics"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", ADMIN, "select public.record_daily_metrics()"), /permission denied/);
});

test("owners can't mark their own page as a test page", async () => {
  await assert.rejects(runAs(db, "authenticated", OWNER, "update public.nonprofits set is_test = true where id = $1", [realNp]), /permission denied/);
});
