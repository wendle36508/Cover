// Tests for scripts/seed-demo.mjs, including running its SQL on the real database setup. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { seedSql, sqlText } from "../scripts/seed-demo.mjs";
import { freshDatabase } from "./support/database.js";

test("text with quotes can't break out of the SQL", () => {
  assert.equal(sqlText("it's"), "'it''s'");
  assert.equal(sqlText("'); drop table sponsors; --"), "'''); drop table sponsors; --'");
  assert.equal(sqlText(null), "null");
});

test("bad input is refused with a clear message", () => {
  assert.throws(() => seedSql("zoo", "harbor-paws", "acct_1"), /Unknown demo/);
  assert.throws(() => seedSql("rescue", "Harbor Paws", "acct_1"), /page link/);
  assert.throws(() => seedSql("rescue", "harbor-paws", "sk_test_oops"), /acct_/);
});

test("the seed loads a live page with its things to follow, and running it twice is safe", async () => {
  const db = await freshDatabase();
  const sql = seedSql("rescue", "harbor-paws", "acct_1TestAbc");
  await db.exec(sql);
  await db.exec(sql);
  const np = (await db.query("select name, is_live, stripe_account_id, monthly_price_cents, page->>'headline' as headline from public.nonprofits")).rows;
  assert.deepEqual(np, [{ name: "Harbor Paws Rescue", is_live: true, stripe_account_id: "acct_1TestAbc", monthly_price_cents: 2500, headline: "Sponsor a dog for $25 a month." }]);
  const items = (await db.query("select name, photo_url from public.follow_items order by sort_order")).rows;
  assert.equal(items.length, 6);
  assert.deepEqual(items[0], { name: "Bella", photo_url: "photos/dog-smile.jpg" });
  await db.close();
});

test("every demo nonprofit seeds cleanly", async () => {
  const db = await freshDatabase();
  await db.exec(seedSql("pantry", "eastside-pantry", "acct_1Pantry"));
  await db.exec(seedSql("youth", "northside-youth", "acct_1Youth"));
  assert.equal((await db.query("select count(*)::int as n from public.nonprofits")).rows[0].n, 2);
  // Two nonprofits can never share one Stripe account (money would go to the wrong place).
  await assert.rejects(db.exec(seedSql("rescue", "harbor-paws", "acct_1Pantry")), /stripe_account_id/);
  await db.close();
});
