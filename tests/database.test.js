// Tests for supabase/migrations: runs the real database setup in PGlite (Postgres in Node)
// with stand-ins for Supabase's login roles, then tries to break the safety rules.
// Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const STAFF_A = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

let db;
let liveId;
let draftId;
let bellaId;

const as = (role, userId, sql, params) => runAs(db, role, userId, sql, params);

const visitor = (sql, params) => as("anon", null, sql, params);
const staffA = (sql, params) => as("authenticated", STAFF_A, sql, params);
const stranger = (sql, params) => as("authenticated", STRANGER, sql, params);

before(async () => {
  db = await freshDatabase();
  liveId = (await db.query(
    "insert into public.nonprofits (slug, name, kind, is_live, stripe_account_id) values ('harbor-paws', 'Harbor Paws Rescue', 'animal', true, 'acct_live') returning id",
  )).rows[0].id;
  draftId = (await db.query(
    "insert into public.nonprofits (slug, name, is_live) values ('quiet-pantry', 'Quiet Pantry', false) returning id",
  )).rows[0].id;
  bellaId = (await db.query(
    "insert into public.follow_items (nonprofit_id, name) values ($1, 'Bella') returning id", [liveId],
  )).rows[0].id;
  await db.query("insert into public.follow_items (nonprofit_id, name) values ($1, 'Moose'), ($2, 'Family Night')", [liveId, draftId]);
  await db.query(`
    insert into public.sponsors (nonprofit_id, item_id, first_name, email, show_name, business_name, monthly_cents, status, created_at) values
      ($1, $2, 'Sarah', 'sarah@example.com', true,  null,                  2500, 'active',   now() - interval '3 hours'),
      ($1, $2, 'Jon',   'jon@example.com',   false, null,                  2500, 'active',   now() - interval '2 hours'),
      ($1, $2, 'Ann',   'ann@example.com',   true,  'Bay Street Hardware', 10000, 'active',  now() - interval '1 hour'),
      ($1, $2, 'Pat',   'pat@example.com',   true,  null,                  2500, 'pending',  now()),
      ($1, $2, 'Lee',   'lee@example.com',   true,  null,                  2500, 'canceled', now()),
      ($3, null, 'Kim', 'kim@example.com',   true,  null,                  2500, 'active',   now())
  `, [liveId, bellaId, draftId]);
  await db.query("insert into auth.users (id) values ($1), ($2)", [STAFF_A, STRANGER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner')", [STAFF_A, liveId]);
});

after(async () => {
  await db?.close();
});

// ---------- Visitors (not signed in) ----------

test("visitors see live pages only", async () => {
  const { rows } = await visitor("select slug from public.nonprofits order by slug");
  assert.deepEqual(rows.map((r) => r.slug), ["harbor-paws"]);
});

test("visitors see items on live pages only", async () => {
  const { rows } = await visitor("select name from public.follow_items order by name");
  assert.deepEqual(rows.map((r) => r.name), ["Bella", "Moose"]);
});

test("visitors can't read sponsors or staff at all", async () => {
  await assert.rejects(visitor("select email from public.sponsors"), /permission denied/);
  await assert.rejects(visitor("select * from public.staff"), /permission denied/);
});

test("visitors can't fake a sponsor, change a page, or add items", async () => {
  await assert.rejects(
    visitor("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'X', 'x@example.com', 2500, 'active')", [liveId]),
    /permission denied/,
  );
  await assert.rejects(visitor("update public.nonprofits set name = 'Hacked'"), /permission denied/);
  await assert.rejects(visitor("insert into public.follow_items (nonprofit_id, name) values ($1, 'Fake')", [liveId]), /permission denied/);
});

test("public counts include active sponsors only", async () => {
  const counts = await visitor("select * from public.page_item_counts($1)", [liveId]);
  assert.deepEqual(counts.rows, [{ item_id: bellaId, sponsors: 3 }]);
  const covered = await visitor("select public.page_monthly_covered($1) as cents", [liveId]);
  assert.equal(Number(covered.rows[0].cents), 15000);
});

test("public sponsor names follow the privacy choice and never include emails", async () => {
  const { rows, fields } = await visitor("select * from public.page_recent_sponsors($1, 10)", [liveId]);
  assert.deepEqual(rows.map((r) => r.display_name), ["Bay Street Hardware", "A neighbor", "Sarah"]);
  assert.deepEqual(fields.map((f) => f.name), ["display_name", "item_name", "joined_at"]);
});

test("public functions show nothing for a page that isn't live", async () => {
  assert.equal((await visitor("select * from public.page_recent_sponsors($1)", [draftId])).rows.length, 0);
  assert.equal(Number((await visitor("select public.page_monthly_covered($1) as c", [draftId])).rows[0].c), 0);
});

test("recent sponsors list is capped and handles odd sizes", async () => {
  assert.equal((await visitor("select * from public.page_recent_sponsors($1, 1)", [liveId])).rows.length, 1);
  assert.equal((await visitor("select * from public.page_recent_sponsors($1, -5)", [liveId])).rows.length, 0);
  assert.equal((await visitor("select * from public.page_recent_sponsors($1, 9999)", [liveId])).rows.length, 3);
});

// ---------- Nonprofit staff ----------

test("staff see their own sponsors, emails included, and no one else's", async () => {
  const { rows } = await staffA("select email from public.sponsors order by email");
  assert.equal(rows.length, 5);
  assert.ok(!rows.some((r) => r.email === "kim@example.com"));
});

test("a signed-in stranger sees no sponsors", async () => {
  assert.equal((await stranger("select * from public.sponsors")).rows.length, 0);
});

test("staff can edit their page text but not Stripe IDs or the live switch", async () => {
  const updated = await staffA("update public.nonprofits set name = 'Harbor Paws' where id = $1 returning name", [liveId]);
  assert.equal(updated.rows[0].name, "Harbor Paws");
  await assert.rejects(staffA("update public.nonprofits set stripe_account_id = 'acct_evil' where id = $1", [liveId]), /permission denied/);
  await assert.rejects(staffA("update public.nonprofits set is_live = false where id = $1", [liveId]), /permission denied/);
});

test("staff can't edit another nonprofit's page", async () => {
  const result = await staffA("update public.nonprofits set name = 'Hacked' where id = $1 returning id", [draftId]);
  assert.equal(result.rows.length, 0);
});

test("staff manage items on their page only", async () => {
  const added = await staffA("insert into public.follow_items (nonprofit_id, name) values ($1, 'Pepper') returning name", [liveId]);
  assert.equal(added.rows[0].name, "Pepper");
  await assert.rejects(
    staffA("insert into public.follow_items (nonprofit_id, name) values ($1, 'Sneaky') returning name", [draftId]),
    /row-level security/,
  );
  const finished = await staffA("update public.follow_items set status = 'finished', finished_note = 'Adopted!' where name = 'Pepper' returning status");
  assert.equal(finished.rows[0].status, "finished");
});

test("the staff-check helper isn't reachable from the public API", async () => {
  await assert.rejects(visitor("select public.is_staff($1)", [liveId]), /does not exist/);
  const { rows } = await db.query("select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'private' and p.proname = 'is_staff'");
  assert.equal(rows[0].n, 1);
});

test("staff can't write sponsor records (only Cover's server can)", async () => {
  await assert.rejects(staffA("update public.sponsors set status = 'active'"), /permission denied/);
  await assert.rejects(staffA("delete from public.sponsors"), /permission denied/);
});

// ---------- Data checks ----------

test("bad data is rejected by the database itself", async () => {
  await assert.rejects(db.query("insert into public.nonprofits (slug, name) values ('Bad Slug!', 'X Y')"), /check constraint/);
  await assert.rejects(db.query("insert into public.nonprofits (slug, name, monthly_price_cents) values ('cheap-one', 'Cheap', 1)"), /check constraint/);
  await assert.rejects(
    db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents) values ($1, 'A', 'not-an-email', 2500)", [liveId]),
    /check constraint/,
  );
  await assert.rejects(
    db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents) values ($1, 'A', 'a@example.com', -1)", [liveId]),
    /check constraint/,
  );
  await assert.rejects(
    db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'A', 'a@example.com', 2500, 'free')", [liveId]),
    /check constraint/,
  );
});

test("sponsor updated_at moves when a sponsor changes", async () => {
  const before_ = (await db.query("select updated_at from public.sponsors where email = 'pat@example.com'")).rows[0].updated_at;
  await db.query("select pg_sleep(0.01)");
  const after_ = (await db.query("update public.sponsors set status = 'active' where email = 'pat@example.com' returning updated_at")).rows[0].updated_at;
  assert.ok(after_ > before_);
});
