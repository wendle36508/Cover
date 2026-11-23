// Tests for the giving_options migration (new checkout): how often, the real amount, gift details,
// and the one-time status, including that one-time and yearly gifts keep monthly totals true.
// Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

let db;
let nonprofit;

before(async () => {
  db = await freshDatabase();
  nonprofit = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('lucky', 'Lucky Pup', 'animal', true) returning id")).rows[0].id;
});

after(async () => {
  await db?.close();
});

const add = (columns) => db.query(
  `insert into public.sponsors (nonprofit_id, first_name, email, ${Object.keys(columns).join(", ")}) values ($1, 'Sam', 'sam@example.com', ${Object.keys(columns).map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
  [nonprofit, ...Object.values(columns)]);

test("old gifts read as monthly with no gift", async () => {
  const row = (await add({ monthly_cents: 2500 })).rows[0];
  assert.deepEqual([row.interval, row.amount_cents, row.gift_name, row.gift_send_on], ["month", null, null, null]);
});

test("yearly and one-time gifts, with their real amount", async () => {
  const yearly = (await add({ monthly_cents: 1667, amount_cents: 20000, interval: "year", status: "active" })).rows[0];
  assert.deepEqual([yearly.interval, yearly.amount_cents], ["year", 20000]);
  const once = (await add({ monthly_cents: 5000, amount_cents: 5000, interval: "once", status: "gave_once" })).rows[0];
  assert.equal(once.status, "gave_once");
  await assert.rejects(add({ monthly_cents: 100, interval: "weekly" }), /check constraint/);
  await assert.rejects(add({ monthly_cents: 100, status: "given" }), /check constraint/);
});

test("a gift needs both a name and an email; bad emails are refused", async () => {
  const gift = (await add({ monthly_cents: 2500, gift_name: "Mom", gift_email: "mom@example.com", gift_message: "Happy birthday!", gift_send_on: "2026-12-25" })).rows[0];
  assert.equal(gift.gift_name, "Mom");
  await assert.rejects(add({ monthly_cents: 2500, gift_name: "Mom" }), /sponsors_gift_complete/);
  await assert.rejects(add({ monthly_cents: 2500, gift_name: "Mom", gift_email: "not-an-email" }), /check constraint/);
  await assert.rejects(add({ monthly_cents: 2500, gift_name: "Mom", gift_email: "mom@example.com", gift_message: "x".repeat(301) }), /check constraint/);
});

test("the page's monthly total counts yearly gifts by month and leaves one-time gifts out", async () => {
  await db.query("delete from public.sponsors");
  await add({ monthly_cents: 2500, status: "active" });
  await add({ monthly_cents: 1667, amount_cents: 20000, interval: "year", status: "active" });
  await add({ monthly_cents: 5000, amount_cents: 5000, interval: "once", status: "gave_once" });
  const covered = (await runAs(db, "anon", null, "select public.page_monthly_covered($1) as c", [nonprofit])).rows[0].c;
  assert.equal(Number(covered), 4167, "$25 + $200/12, and not the $50 one-time gift");
});
