// Tests for nonprofit sign-up (create_my_nonprofit) and photo storage rules. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const MARIA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const signUp = (userId, ...args) =>
  runAs(db, "authenticated", userId, "select public.create_my_nonprofit($1, $2, $3, $4, $5, $6) as slug", args);

let db;
let mariaNonprofit;

before(async () => {
  db = await freshDatabase();
  await db.query("insert into auth.users (id) values ($1), ($2)", [MARIA, SAM]);
});

after(async () => {
  await db?.close();
});

test("a signed-in person creates their nonprofit and becomes its owner", async () => {
  const { rows } = await signUp(MARIA, "  Harbor   Paws Rescue ", "Harbor-Paws", "animal", "Dogs", 2500, 200000);
  assert.equal(rows[0].slug, "harbor-paws");
  const np = (await db.query("select id, name, is_live, stripe_account_id, page->>'navLabel' as label from public.nonprofits")).rows[0];
  assert.deepEqual({ ...np, id: undefined }, { id: undefined, name: "Harbor Paws Rescue", is_live: false, stripe_account_id: null, label: "Dogs" });
  mariaNonprofit = np.id;
  const staff = (await db.query("select role from public.staff where user_id = $1", [MARIA])).rows;
  assert.deepEqual(staff, [{ role: "owner" }]);
});

test("a new page is hidden from the public until Stripe approves it", async () => {
  const visitor = await runAs(db, "anon", null, "select slug from public.nonprofits");
  assert.equal(visitor.rows.length, 0);
  const owner = await runAs(db, "authenticated", MARIA, "select slug from public.nonprofits");
  assert.equal(owner.rows.length, 1);
});

test("one nonprofit per person, and page links are unique", async () => {
  await assert.rejects(signUp(MARIA, "Second Org", "second-org", "program", "Programs", 2500, 100000), /already run a nonprofit/);
  await assert.rejects(signUp(SAM, "Copycat", "harbor-paws", "program", "Programs", 2500, 100000), /link is taken/);
});

test("visitors who aren't signed in can't create nonprofits", async () => {
  await assert.rejects(
    runAs(db, "anon", null, "select public.create_my_nonprofit('X Org', 'x-org', 'program', 'Programs', 2500, 1000)"),
    /permission denied/,
  );
});

for (const [label, args, message] of [
  ["name too short", ["A", "ok-link", "program", "Programs", 2500, 1000], /name/],
  ["bad page link", ["Good Name", "Bad Link!", "program", "Programs", 2500, 1000], /page link/],
  ["short page link", ["Good Name", "ab", "program", "Programs", 2500, 1000], /page link/],
  ["unknown kind", ["Good Name", "good-link", "plants", "Programs", 2500, 1000], /animals or programs/],
  ["missing follow label", ["Good Name", "good-link", "program", "", 2500, 1000], /follow/],
  ["price too low", ["Good Name", "good-link", "program", "Programs", 100, 1000], /monthly amount/],
  ["price missing", ["Good Name", "good-link", "program", "Programs", null, 1000], /monthly amount/],
  ["goal too high", ["Good Name", "good-link", "program", "Programs", 2500, 999999999], /goal/],
]) {
  test(`sign-up refuses: ${label}`, async () => {
    await assert.rejects(signUp(SAM, ...args), message);
  });
}

test("staff can change their monthly amount but still not Stripe ids or the live switch", async () => {
  const changed = await runAs(db, "authenticated", MARIA, "update public.nonprofits set monthly_price_cents = 3000 returning monthly_price_cents");
  assert.equal(changed.rows[0].monthly_price_cents, 3000);
  await assert.rejects(runAs(db, "authenticated", MARIA, "update public.nonprofits set is_live = true"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", MARIA, "update public.nonprofits set stripe_account_id = 'acct_x'"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", MARIA, "update public.nonprofits set monthly_price_cents = 1"), /check constraint/);
});

// ---------- photo storage ----------

test("the photos bucket is public to view, images only, 5 MB max", async () => {
  const bucket = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'photos'")).rows[0];
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 5 * 1024 * 1024);
  assert.deepEqual(bucket.allowed_mime_types, ["image/jpeg", "image/png", "image/webp"]);
});

test("staff upload photos only into their own nonprofit's folder", async () => {
  const mine = await runAs(db, "authenticated", MARIA, "insert into storage.objects (bucket_id, name) values ('photos', $1) returning name", [`${mariaNonprofit}/bella.jpg`]);
  assert.equal(mine.rows.length, 1);
  await assert.rejects(
    runAs(db, "authenticated", SAM, "insert into storage.objects (bucket_id, name) values ('photos', $1)", [`${mariaNonprofit}/sneaky.jpg`]),
    /row-level security/,
  );
  await assert.rejects(
    runAs(db, "authenticated", MARIA, "insert into storage.objects (bucket_id, name) values ('photos', 'not-a-folder/x.jpg')"),
    /row-level security/,
  );
  await assert.rejects(
    runAs(db, "anon", null, "insert into storage.objects (bucket_id, name) values ('photos', $1)", [`${mariaNonprofit}/anon.jpg`]),
    /row-level security/,
  );
});

test("other people can't delete a nonprofit's photos", async () => {
  const removed = await runAs(db, "authenticated", SAM, "delete from storage.objects where bucket_id = 'photos' returning name");
  assert.equal(removed.rows.length, 0);
  const own = await runAs(db, "authenticated", MARIA, "delete from storage.objects where bucket_id = 'photos' returning name");
  assert.equal(own.rows.length, 1);
});
