// Tests for the sponsor-emails migration: the "stop updates" switch, the email log, and
// "Mark adopted" (finish_item) moving sponsors to the next buddy. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "33333333-3333-3333-3333-333333333333";

let db;
let rescue;
let pantry;
let bella;
let max;
let luna;
let pantryItem;

const as = (userId, sql, params) => runAs(db, "authenticated", userId, sql, params);
const finish = (userId, item, next, note = null) => as(userId, "select * from public.finish_item($1, $2, $3) order by first_name", [item, next, note]);
const followOf = async (name) => (await db.query("select item_id from public.sponsors where first_name = $1", [name])).rows[0].item_id;

before(async () => {
  db = await freshDatabase();
  rescue = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('harbor-paws', 'Harbor Paws', 'animal', true) returning id")).rows[0].id;
  pantry = (await db.query("insert into public.nonprofits (slug, name, is_live) values ('pantry', 'Pantry', true) returning id")).rows[0].id;
  [bella, max, luna] = (await db.query(
    "insert into public.follow_items (nonprofit_id, name, sort_order) values ($1, 'Bella', 1), ($1, 'Max', 2), ($1, 'Luna', 3) returning id", [rescue],
  )).rows.map((r) => r.id);
  pantryItem = (await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Shelves') returning id", [pantry])).rows[0].id;
  await db.query(`
    insert into public.sponsors (nonprofit_id, item_id, first_name, email, monthly_cents, status, updates_off) values
      ($1, $2, 'Ann',  'ann@example.com',  2500, 'active',   false),
      ($1, $2, 'Bo',   'bo@example.com',   2500, 'past_due', false),
      ($1, $2, 'Cy',   'cy@example.com',   2500, 'active',   true),
      ($1, $2, 'Di',   'di@example.com',   2500, 'pending',  false),
      ($1, $2, 'Ed',   'ed@example.com',   2500, 'canceled', false),
      ($1, $3, 'Flo',  'flo@example.com',  2500, 'active',   false)
  `, [rescue, bella, luna]);
  await db.query("insert into auth.users (id) values ($1), ($2)", [OWNER, OTHER_OWNER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [OWNER, rescue, OTHER_OWNER, pantry]);
});

after(async () => {
  await db?.close();
});

test("sponsorships start with updates on", async () => {
  const { rows } = await db.query("select count(*)::int as n from public.sponsors where not updates_off");
  assert.equal(rows[0].n, 5);
});

test("another nonprofit's owner can't finish your dog", async () => {
  await assert.rejects(finish(OTHER_OWNER, bella, max), /Only this nonprofit's team/);
  await assert.rejects(runAs(db, "anon", null, "select * from public.finish_item($1, $2)", [bella, max]), /permission denied/);
});

test("the next buddy must be another active one from the same nonprofit", async () => {
  await assert.rejects(finish(OWNER, bella, bella), /still on your page/);
  await assert.rejects(finish(OWNER, bella, pantryItem), /still on your page/);
});

test("Mark adopted moves sponsors to the next buddy and returns who to email", async () => {
  const { rows } = await finish(OWNER, bella, max, "  Went home with the Lee family!  ");
  // Paying sponsors come back (muted ones too, flagged), pending and canceled don't.
  assert.deepEqual(rows.map((r) => [r.first_name, r.updates_off]), [["Ann", false], ["Bo", false], ["Cy", true]]);
  for (const name of ["Ann", "Bo", "Cy", "Di"]) assert.equal(await followOf(name), max, name);
  assert.equal(await followOf("Ed"), bella, "canceled sponsors stay where they were");
  const item = (await db.query("select status, finished_note from public.follow_items where id = $1", [bella])).rows[0];
  assert.deepEqual(item, { status: "finished", finished_note: "Went home with the Lee family!" });
});

test("a finished one can't be finished twice", async () => {
  await assert.rejects(finish(OWNER, bella, luna), /already finished/);
});

test("with no next buddy, sponsors follow the nonprofit in general", async () => {
  const { rows } = await finish(OWNER, luna, null);
  assert.deepEqual(rows.map((r) => r.first_name), ["Flo"]);
  assert.equal(await followOf("Flo"), null);
});

test("Bring back doesn't pull moved sponsors back", async () => {
  await as(OWNER, "update public.follow_items set status = 'active', finished_note = null where id = $1", [bella]);
  assert.equal(await followOf("Ann"), max);
});

test("the email log is readable by that nonprofit's staff only, and written by no one in the browser", async () => {
  await db.query("insert into public.sponsor_emails (nonprofit_id, kind, status) values ($1, 'adopted', 'sent')", [rescue]);
  assert.equal((await as(OWNER, "select * from public.sponsor_emails")).rows.length, 1);
  assert.equal((await as(OTHER_OWNER, "select * from public.sponsor_emails")).rows.length, 0);
  await assert.rejects(as(OWNER, "insert into public.sponsor_emails (nonprofit_id, kind, status) values ($1, 'update', 'sent')", [rescue]), /permission denied/);
  await assert.rejects(runAs(db, "anon", null, "select * from public.sponsor_emails"), /permission denied/);
});

test("owners still can't flip a sponsor's updates switch themselves", async () => {
  await assert.rejects(as(OWNER, "update public.sponsors set updates_off = true"), /permission denied/);
});
