// Tests for the cover_fee migration: the fee switch starts off, only Cover admins can flip it (never a
// nonprofit's own staff), HQ sees it, and each gift remembers its fee. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const ADMIN = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
let db;
let nonprofit;

before(async () => {
  db = await freshDatabase();
  nonprofit = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('lucky', 'Lucky Pup', 'animal', true) returning id")).rows[0].id;
  await db.query("insert into auth.users (id) values ($1), ($2)", [ADMIN, OWNER]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [ADMIN]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner')", [OWNER, nonprofit]);
});

after(async () => {
  await db?.close();
});

const feeOn = async () => (await db.query("select cover_fee_on from public.nonprofits where id = $1", [nonprofit])).rows[0].cover_fee_on;

test("the fee is off for every nonprofit to start", async () => {
  assert.equal(await feeOn(), false);
});

test("a nonprofit's own staff can't turn the fee on or off", async () => {
  await assert.rejects(runAs(db, "authenticated", OWNER, "update public.nonprofits set cover_fee_on = true where id = $1", [nonprofit]), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select public.admin_set_cover_fee($1, true)", [nonprofit]), /Only Cover admins/);
  await assert.rejects(runAs(db, "anon", null, "select public.admin_set_cover_fee($1, true)", [nonprofit]), /permission denied/);
  assert.equal(await feeOn(), false);
  await runAs(db, "authenticated", OWNER, "update public.nonprofits set name = 'Lucky Pup Rescue' where id = $1", [nonprofit]);
  assert.equal(await feeOn(), false, "editing their page doesn't touch it");
});

test("a Cover admin can switch it on and off, and HQ shows it", async () => {
  const on = (await runAs(db, "authenticated", ADMIN, "select public.admin_set_cover_fee($1, true) as v", [nonprofit])).rows[0].v;
  assert.equal(on, true);
  assert.equal(await feeOn(), true);
  const overview = (await runAs(db, "authenticated", ADMIN, "select public.admin_overview() as o")).rows[0].o;
  const row = overview.nonprofits.find((n) => n.id === nonprofit);
  assert.equal(row.cover_fee_on, true);
  assert.equal(row.name, "Lucky Pup Rescue", "the rest of HQ's overview is unchanged");
  await runAs(db, "authenticated", ADMIN, "select public.admin_set_cover_fee($1, false)", [nonprofit]);
  assert.equal(await feeOn(), false);
  await assert.rejects(runAs(db, "authenticated", ADMIN, "select public.admin_set_cover_fee($1, true)", ["33333333-3333-3333-3333-333333333333"]), /doesn't exist/);
});

test("visitors can see whether the fee is on (the page needs it for the fee line)", async () => {
  const seen = (await runAs(db, "anon", null, "select cover_fee_on from public.nonprofits where id = $1", [nonprofit])).rows[0];
  assert.equal(seen.cover_fee_on, false);
});

test("each gift remembers its own fee and cover; old gifts default to no fee", async () => {
  const plain = (await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents) values ($1, 'Sam', 'sam@example.com', 2500) returning fee_percent, covers_fee", [nonprofit])).rows[0];
  assert.deepEqual(plain, { fee_percent: 0, covers_fee: false });
  const covered = (await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, fee_percent, covers_fee) values ($1, 'Sara', 'sara@example.com', 2578, 3, true) returning fee_percent, covers_fee", [nonprofit])).rows[0];
  assert.deepEqual(covered, { fee_percent: 3, covers_fee: true });
  await assert.rejects(db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, fee_percent) values ($1, 'X', 'x@example.com', 2500, 50)", [nonprofit]), /check constraint/);
});
