// Tests for the live_nonprofits migration: the homepage sees only live, real nonprofits, and only
// public info (no sponsors, no money). Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

let db;

before(async () => {
  db = await freshDatabase();
  const add = async (slug, live, isTest) => (await db.query(
    "insert into public.nonprofits (slug, name, kind, is_live, is_test, page) values ($1, $1, 'animal', $2, $3, '{\"logo\":\"https://x/logo.png\",\"navLabel\":\"Dogs\"}') returning id",
    [slug, live, isTest])).rows[0].id;
  const lucky = await add("lucky", true, false);
  await add("not-live-yet", false, false);
  await add("practice-page", true, true);
  for (let i = 0; i < 6; i += 1) {
    await db.query("insert into public.follow_items (nonprofit_id, name, photo_url, sort_order) values ($1, $2, $3, $4)", [lucky, `Dog ${i}`, i === 0 ? null : `https://x/${i}.jpg`, i]);
  }
  await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'Sam', 'sam@example.com', 2500, 'active')", [lucky]);
});

after(async () => {
  await db?.close();
});

test("only live, real nonprofits; visitors can ask", async () => {
  const list = (await runAs(db, "anon", null, "select public.live_nonprofits() as l")).rows[0].l;
  assert.deepEqual(list.map((n) => n.slug), ["lucky"]);
});

test("up to 4 photos with names, and nothing private", async () => {
  const [lucky] = (await runAs(db, "anon", null, "select public.live_nonprofits() as l")).rows[0].l;
  assert.deepEqual(lucky.items.map((i) => i.name), ["Dog 1", "Dog 2", "Dog 3", "Dog 4"], "only dogs with photos, in page order");
  assert.equal(lucky.logo, "https://x/logo.png");
  assert.doesNotMatch(JSON.stringify(lucky), /sam@example|2500|sponsor/i);
});
