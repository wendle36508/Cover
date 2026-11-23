// Tests for the share_card database function: what a share preview may know about a nonprofit
// (name, photos, dogs' names and tags) and what it never gets (sponsors, emails, Stripe). Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

let db;

before(async () => {
  db = await freshDatabase();
  const lucky = (await db.query(`insert into public.nonprofits (slug, name, kind, is_live, page, stripe_account_id)
    values ('lucky-pup-rescue', 'Lucky Pup Rescue', 'animal', false, '{"navLabel":"Dogs","logo":"https://x/logo.png","coverPhoto":"https://x/cover.jpg"}', 'acct_secret123') returning id`)).rows[0].id;
  await db.query("insert into public.nonprofits (slug, name, is_live, is_test) values ('practice', 'Practice', true, true)");
  await db.query(`insert into public.follow_items (nonprofit_id, name, badge, photo_url, sort_order, status) values
    ($1, 'Burt', 'Learning leash manners', 'https://x/burt.jpg', 0, 'active'),
    ($1, 'Fiona', null, null, 1, 'active'),
    ($1, 'Old Yeller', null, null, 2, 'finished')`, [lucky]);
  await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'Sarah', 'sarah@example.com', 2500, 'active')", [lucky]);
});

after(async () => {
  await db?.close();
});

const card = async (slug, role = "anon") => (await runAs(db, role, null, "select public.share_card($1) as c", [slug])).rows[0].c;

test("anyone (the share helper) can get a nonprofit's card, even before it's live", async () => {
  const c = await card("lucky-pup-rescue");
  assert.equal(c.name, "Lucky Pup Rescue");
  assert.equal(c.nav_label, "Dogs");
  assert.equal(c.cover_photo, "https://x/cover.jpg");
  assert.equal(c.price_cents, 2500);
  assert.deepEqual(c.items.map((i) => i.name), ["Burt", "Fiona"], "adopted/finished ones are left out, in page order");
  assert.equal(c.items[0].badge, "Learning leash manners");
  assert.equal((await card("  LUCKY-PUP-RESCUE ")).name, "Lucky Pup Rescue", "case and spaces don't matter");
});

test("unknown and practice pages get nothing", async () => {
  assert.equal(await card("nobody"), null);
  assert.equal(await card("practice"), null);
  assert.equal(await card(null), null);
});

test("a card never includes sponsors, emails or Stripe details", async () => {
  const text = JSON.stringify(await card("lucky-pup-rescue"));
  for (const secret of ["sarah", "acct_secret123", "monthly_cents", "email", "stripe"]) assert.doesNotMatch(text, new RegExp(secret, "i"), secret);
});
