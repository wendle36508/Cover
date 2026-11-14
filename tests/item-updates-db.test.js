// Tests for the item-updates migration: owners post an update, at most one email per dog per day,
// extras scheduled for the next free morning (9am Eastern). Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "33333333-3333-3333-3333-333333333333";

let db;
let rescue;
let bella;
let max;
let other;

const post = (userId, item, text, photo = null) =>
  runAs(db, "authenticated", userId, `select update_id, send_now, to_char(send_after at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI') as local from public.post_update($1, $2, $3)`, [item, text, photo]);
const easternToday = async () => (await db.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d;
const dayPlus = (isoDate, days) => new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

before(async () => {
  db = await freshDatabase();
  rescue = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('harbor-paws', 'Harbor Paws', 'animal', true) returning id")).rows[0].id;
  const pantry = (await db.query("insert into public.nonprofits (slug, name) values ('pantry', 'Pantry') returning id")).rows[0].id;
  [bella, max] = (await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Bella'), ($1, 'Max') returning id", [rescue])).rows.map((r) => r.id);
  other = (await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Shelves') returning id", [pantry])).rows[0].id;
  await db.query("insert into auth.users (id) values ($1), ($2)", [OWNER, OTHER_OWNER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [OWNER, rescue, OTHER_OWNER, pantry]);
});

after(async () => {
  await db?.close();
});

test("the first update today goes out now", async () => {
  const { rows } = await post(OWNER, bella, "  Bella   learned to sit today!  ");
  assert.equal(rows[0].send_now, true);
  const saved = (await db.query("select body, status from public.item_updates where id = $1", [rows[0].update_id])).rows[0];
  assert.deepEqual(saved, { body: "Bella learned to sit today!", status: "queued" });
});

test("a second update the same day waits for tomorrow 9am Eastern, a third for the day after", async () => {
  const today = await easternToday();
  const second = (await post(OWNER, bella, "Second one")).rows[0];
  assert.equal(second.send_now, false);
  assert.equal(second.local, `${dayPlus(today, 1)}T09:00`);
  const third = (await post(OWNER, bella, "Third one")).rows[0];
  assert.equal(third.local, `${dayPlus(today, 2)}T09:00`);
});

test("each dog has its own daily limit", async () => {
  assert.equal((await post(OWNER, max, "Max had a bath")).rows[0].send_now, true);
});

test("a failed send doesn't use up the day", async () => {
  await db.query("update public.item_updates set status = 'failed' where item_id = $1", [max]);
  assert.equal((await post(OWNER, max, "Trying again")).rows[0].send_now, true);
});

test("only this nonprofit's team can post, and only good input", async () => {
  await assert.rejects(post(OTHER_OWNER, bella, "Hi"), /Only this nonprofit's team/);
  await assert.rejects(post(OWNER, other, "Hi"), /Only this nonprofit's team/);
  await assert.rejects(runAs(db, "anon", null, "select * from public.post_update($1, 'x')", [bella]), /permission denied/);
  await assert.rejects(post(OWNER, bella, "   "), /one line/);
  await assert.rejects(post(OWNER, bella, "x".repeat(201)), /one line/);
  await assert.rejects(post(OWNER, bella, "Hi", "javascript:alert(1)"), /photo/);
});

test("finished dogs can't get updates", async () => {
  await db.query("update public.follow_items set status = 'finished' where id = $1", [max]);
  await assert.rejects(post(OWNER, max, "Hi"), /isn't on your page/);
});

test("updates are readable by that team only and written only through post_update", async () => {
  assert.ok((await runAs(db, "authenticated", OWNER, "select * from public.item_updates")).rows.length >= 4);
  assert.equal((await runAs(db, "authenticated", OTHER_OWNER, "select * from public.item_updates")).rows.length, 0);
  await assert.rejects(
    runAs(db, "authenticated", OWNER, "insert into public.item_updates (nonprofit_id, item_id, body, send_after) values ($1, $2, 'x', now())", [rescue, bella]),
    /permission denied/,
  );
});
