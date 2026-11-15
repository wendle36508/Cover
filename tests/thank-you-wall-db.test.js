// Tests for the thank-you wall migration: opt-in only, "Sarah K." names, owner hide/show,
// no counts or dog names on the wall, and the pop-up following the same opt-in. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "33333333-3333-3333-3333-333333333333";

let db;
let rescue;
let draft;
let bella;
const ids = {};

const anon = (sql, params) => runAs(db, "anon", null, sql, params);
const as = (userId, sql, params) => runAs(db, "authenticated", userId, sql, params);
const wall = async (target = rescue) => (await anon("select * from public.page_thank_you_wall($1)", [target])).rows;
const names = async (target) => (await wall(target)).map((r) => r.display_name);

before(async () => {
  db = await freshDatabase();
  rescue = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('harbor-paws', 'Harbor Paws', 'animal', true) returning id")).rows[0].id;
  draft = (await db.query("insert into public.nonprofits (slug, name, is_live) values ('draft-page', 'Draft', false) returning id")).rows[0].id;
  bella = (await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Bella') returning id", [rescue])).rows[0].id;
  const rows = [
    // name, last initial, opted in, business, status, minutes ago
    ["Sarah", "K", true, null, "active", 1],
    ["Marcus", null, true, null, "active", 2],
    ["Quiet", "Q", false, null, "active", 3],
    ["Biz", null, true, "Corner Cafe", "active", 4],
    ["Gone", "G", true, null, "canceled", 5],
    ["Waiting", "W", true, null, "pending", 6],
    ["Late", "L", true, null, "past_due", 7],
  ];
  for (const [first, initial, optIn, business, status, ago] of rows) {
    ids[first] = (await db.query(
      `insert into public.sponsors (nonprofit_id, item_id, first_name, email, last_initial, show_name, business_name, monthly_cents, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 2500, $8, now() - make_interval(mins => $9)) returning id`,
      [rescue, bella, first, `${first.toLowerCase()}@example.com`, initial, optIn, business, status, ago],
    )).rows[0].id;
  }
  await db.query("insert into public.sponsors (nonprofit_id, first_name, email, show_name, monthly_cents, status) values ($1, 'Hidden', 'h@example.com', true, 2500, 'active')", [draft]);
  await db.query("insert into auth.users (id) values ($1), ($2)", [OWNER, OTHER_OWNER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [OWNER, rescue, OTHER_OWNER, draft]);
});

after(async () => {
  await db?.close();
});

test("new sponsors are off the wall unless they tick the box", async () => {
  const id = (await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents) values ($1, 'New', 'new@example.com', 2500) returning show_name, wall_hidden", [rescue])).rows[0];
  assert.deepEqual(id, { show_name: false, wall_hidden: false });
  await db.query("delete from public.sponsors where first_name = 'New'");
});

test("the wall shows only active sponsors who opted in, newest first, as 'Sarah K.'", async () => {
  assert.deepEqual(await names(), ["Sarah K.", "Marcus", "Corner Cafe"]);
});

test("the wall gives names and dates only: no amounts, no dogs, no emails", async () => {
  const [first] = await wall();
  assert.deepEqual(Object.keys(first).sort(), ["display_name", "joined_at"]);
});

test("a page that isn't live has an empty wall", async () => {
  assert.deepEqual(await names(draft), []);
});

test("last initials must be one capital letter", async () => {
  for (const bad of ["k", "KK", "1", ""]) {
    await assert.rejects(
      db.query("insert into public.sponsors (nonprofit_id, first_name, email, last_initial, monthly_cents) values ($1, 'X', 'x@example.com', $2, 2500)", [rescue, bad]),
      /check constraint/, bad,
    );
  }
});

test("the owner can hide a name and bring it back", async () => {
  assert.equal((await as(OWNER, "select public.set_wall_hidden($1, true) as hidden", [ids.Marcus])).rows[0].hidden, true);
  assert.deepEqual(await names(), ["Sarah K.", "Corner Cafe"]);
  await as(OWNER, "select public.set_wall_hidden($1, false)", [ids.Marcus]);
  assert.deepEqual(await names(), ["Sarah K.", "Marcus", "Corner Cafe"]);
});

test("only that nonprofit's team can hide names", async () => {
  await assert.rejects(as(OTHER_OWNER, "select public.set_wall_hidden($1, true)", [ids.Sarah]), /Only this nonprofit's team/);
  await assert.rejects(anon("select public.set_wall_hidden($1, true)", [ids.Sarah]), /permission denied/);
  await assert.rejects(as(OWNER, "select public.set_wall_hidden($1, true)", ["99999999-9999-9999-9999-999999999999"]), /couldn't find/);
});

test("the pop-up names only opted-in sponsors; everyone else is 'A neighbor'", async () => {
  await as(OWNER, "select public.set_wall_hidden($1, true)", [ids.Marcus]);
  const { rows } = await anon("select display_name, item_name from public.page_recent_sponsors($1, 20)", [rescue]);
  assert.deepEqual(rows.map((r) => r.display_name), ["Sarah K.", "A neighbor", "A neighbor", "Corner Cafe"]);
  assert.equal(rows[0].item_name, "Bella");
  await as(OWNER, "select public.set_wall_hidden($1, false)", [ids.Marcus]);
});

test("browsers still can't change sponsors directly", async () => {
  await assert.rejects(as(OWNER, "update public.sponsors set wall_hidden = true where id = $1", [ids.Sarah]), /permission denied/);
  await assert.rejects(anon("select * from public.sponsors"), /permission denied/);
});
