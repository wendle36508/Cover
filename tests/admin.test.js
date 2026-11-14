// Tests for Cover admin mode and owner invites (admin_invites migration). Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const TANNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // Cover admin
const MARIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // rescue owner, invited
const MALLORY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // not an admin
const as = (user, sql, params) => runAs(db, "authenticated", user, sql, params);
const create = (user, name, slug) =>
  as(user, "select public.admin_create_nonprofit($1, $2, 'animal', 'Dogs', 2500, 200000) as id", [name, slug]);

let db;
let rescueId;

before(async () => {
  db = await freshDatabase();
  await db.query("insert into auth.users (id, email) values ($1, 'tanner@example.com'), ($2, 'Maria@Rescue.org'), ($3, 'mallory@example.com')", [TANNER, MARIA, MALLORY]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [TANNER]);
});

after(async () => {
  await db?.close();
});

test("only admins know they're admins", async () => {
  assert.equal((await as(TANNER, "select public.am_i_cover_admin() as yes")).rows[0].yes, true);
  assert.equal((await as(MALLORY, "select public.am_i_cover_admin() as yes")).rows[0].yes, false);
  await assert.rejects(runAs(db, "anon", null, "select public.am_i_cover_admin()"), /permission denied/);
  await assert.rejects(as(MALLORY, "select * from public.cover_admins"), /permission denied/);
});

test("an admin creates pages for several nonprofits and helps run each", async () => {
  rescueId = (await create(TANNER, "Harbor Paws Rescue", "harbor-paws")).rows[0].id;
  await create(TANNER, "Eastside Pantry", "eastside-pantry");
  const staff = (await as(TANNER, "select role from public.staff order by created_at")).rows;
  assert.deepEqual(staff.map((s) => s.role), ["admin", "admin"]);
  const pages = (await as(TANNER, "select slug, is_live from public.nonprofits order by slug")).rows;
  assert.deepEqual(pages, [{ slug: "eastside-pantry", is_live: false }, { slug: "harbor-paws", is_live: false }]);
});

test("admin-created pages follow the same checks as self sign-up", async () => {
  await assert.rejects(create(TANNER, "Copy", "harbor-paws"), /link is taken/);
  await assert.rejects(create(TANNER, "X", "ok-link"), /name/);
});

test("people who aren't admins can't create pages for others", async () => {
  await assert.rejects(create(MALLORY, "Fake Rescue", "fake-rescue"), /Only Cover admins/);
  await assert.rejects(runAs(db, "anon", null, "select public.admin_create_nonprofit('A B', 'a-b')"), /permission denied/);
});

test("the admin adds dogs to a page they set up", async () => {
  const added = await as(TANNER, "insert into public.follow_items (nonprofit_id, name) values ($1, 'Bella') returning name", [rescueId]);
  assert.equal(added.rows[0].name, "Bella");
});

test("staff invite the owner; strangers can't invite themselves in", async () => {
  await as(TANNER, "select public.invite_to_nonprofit($1, '  MARIA@rescue.org ')", [rescueId]);
  await as(TANNER, "select public.invite_to_nonprofit($1, 'maria@rescue.org')", [rescueId]); // repeat is harmless
  const invites = (await as(TANNER, "select email, role from public.staff_invites")).rows;
  assert.deepEqual(invites, [{ email: "maria@rescue.org", role: "owner" }]);
  await assert.rejects(as(MALLORY, "select public.invite_to_nonprofit($1, 'mallory@example.com')", [rescueId]), /your own nonprofit/);
  assert.equal((await as(MALLORY, "select * from public.staff_invites")).rows.length, 0);
  await assert.rejects(as(TANNER, "select public.invite_to_nonprofit($1, 'not-an-email')", [rescueId]), /doesn't look right/);
  await assert.rejects(as(MALLORY, "insert into public.staff_invites (nonprofit_id, email) values ($1, 'x@y.co')", [rescueId]), /permission denied/);
});

test("the invited owner signs in and their invite turns into ownership", async () => {
  assert.equal((await as(MALLORY, "select public.claim_my_invites() as n")).rows[0].n, 0);
  assert.equal((await as(MARIA, "select public.claim_my_invites() as n")).rows[0].n, 1);
  const mine = (await as(MARIA, "select role, nonprofit_id from public.staff")).rows;
  assert.deepEqual(mine, [{ role: "owner", nonprofit_id: rescueId }]);
  assert.equal((await as(MARIA, "select public.claim_my_invites() as n")).rows[0].n, 0, "an invite is used once");
  const dogs = (await as(MARIA, "select name from public.follow_items")).rows;
  assert.deepEqual(dogs, [{ name: "Bella" }], "the owner sees the dogs Cover added");
});

test("an owner who joined by invite can't also self-create another nonprofit", async () => {
  await assert.rejects(as(MARIA, "select public.create_my_nonprofit('Second', 'second-one')"), /already run a nonprofit/);
});

test("HQ numbers: admins only, counts and names, no emails", async () => {
  await db.query(`insert into public.sponsors (nonprofit_id, item_id, first_name, email, monthly_cents, status)
    select $1, id, 'Sam', 'sam@example.com', 2500, 'active' from public.follow_items where name = 'Bella'`, [rescueId]);
  await db.query("insert into public.stripe_events (id, type, needs_review) values ('evt_dispute', 'charge.dispute.created', true)");
  const hq = (await as(TANNER, "select public.admin_overview() as hq")).rows[0].hq;
  assert.equal(hq.totals.nonprofits, 2);
  assert.equal(hq.totals.active_sponsors, 1);
  assert.equal(Number(hq.totals.monthly_cents), 2500);
  assert.equal(hq.totals.needs_review, 1);
  const rescue = hq.nonprofits.find((n) => n.slug === "harbor-paws");
  assert.equal(rescue.owner_joined, true);
  assert.equal(rescue.things_to_follow, 1);
  assert.equal(rescue.active_sponsors, 1);
  assert.equal(hq.recent_sponsors[0].name, "Sam");
  assert.equal(hq.review_events[0].type, "charge.dispute.created");
  assert.ok(!JSON.stringify(hq).includes("sam@example.com"), "HQ never includes sponsor emails");
  await assert.rejects(as(MARIA, "select public.admin_overview()"), /Only Cover admins/);
  await assert.rejects(runAs(db, "anon", null, "select public.admin_overview()"), /permission denied/);
});

test("staff can cancel an invite; others can't", async () => {
  await as(TANNER, "select public.invite_to_nonprofit($1, 'helper@rescue.org', 'admin')", [rescueId]);
  await assert.rejects(as(MALLORY, "select public.cancel_invite($1, 'helper@rescue.org')", [rescueId]), /your own nonprofit/);
  await as(MARIA, "select public.cancel_invite($1, 'HELPER@rescue.org')", [rescueId]);
  assert.equal((await as(TANNER, "select * from public.staff_invites")).rows.length, 0);
});
