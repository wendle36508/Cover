// Tests for the new_page_switch migration (phase 5): nonprofits that already exist stay on the old page,
// new sign-ups start on the new page, only Cover admins can flip the switch, HQ and the public page can
// see it. Run with: npm test
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

const newPage = async (id = nonprofit) => (await db.query("select new_page from public.nonprofits where id = $1", [id])).rows[0].new_page;

test("nonprofits made from now on start on the new page", async () => {
  assert.equal(await newPage(), true);
  const column = (await db.query("select column_default from information_schema.columns where table_name = 'nonprofits' and column_name = 'new_page'")).rows[0];
  assert.equal(column.column_default, "true");
});

test("existing nonprofits keep the old page: the migration adds the column switched off first", async () => {
  const sql = (await import("node:fs")).readFileSync("supabase/migrations/20261129000000_new_page_switch.sql", "utf-8");
  assert.ok(sql.indexOf("add column new_page boolean not null default false") < sql.indexOf("alter column new_page set default true"));
});

test("only Cover admins can switch pages, never the nonprofit's own staff", async () => {
  await db.query("update public.nonprofits set new_page = false where id = $1", [nonprofit]);
  await assert.rejects(runAs(db, "authenticated", OWNER, "update public.nonprofits set new_page = true where id = $1", [nonprofit]), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select public.admin_set_new_page($1, true)", [nonprofit]), /Only Cover admins/);
  await assert.rejects(runAs(db, "anon", null, "select public.admin_set_new_page($1, true)", [nonprofit]), /permission denied/);
  assert.equal(await newPage(), false);
});

test("a Cover admin flips it from HQ, and HQ shows which page each uses", async () => {
  const on = (await runAs(db, "authenticated", ADMIN, "select public.admin_set_new_page($1, true) as v", [nonprofit])).rows[0].v;
  assert.equal(on, true);
  assert.equal(await newPage(), true);
  const overview = (await runAs(db, "authenticated", ADMIN, "select public.admin_overview() as o")).rows[0].o;
  assert.equal(overview.nonprofits.find((n) => n.id === nonprofit).new_page, true);
  assert.ok("cover_fee_on" in overview.nonprofits[0], "everything HQ showed before is still there");
  await runAs(db, "authenticated", ADMIN, "select public.admin_set_new_page($1, false)", [nonprofit]);
  assert.equal(await newPage(), false);
  await assert.rejects(runAs(db, "authenticated", ADMIN, "select public.admin_set_new_page($1, true)", ["33333333-3333-3333-3333-333333333333"]), /doesn't exist/);
});

test("the public page can read the switch (so the old link knows to forward)", async () => {
  const seen = (await runAs(db, "anon", null, "select new_page from public.nonprofits where id = $1", [nonprofit])).rows[0];
  assert.equal(seen.new_page, false);
});
