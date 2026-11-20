// Tests for the My gifts migration: finding every gift for one email, the link-request rate limits,
// and logging the link emails with the daily email budget. Run with: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
let db;
let rescue;
let pantry;

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const server = (sql, params) => runAs(db, "service_role", null, sql, params);
const check = async (ip, email) => (await server("select public.manage_link_rate_check($1, $2) as v", [hash(ip), hash(email)])).rows[0].v;

before(async () => {
  db = await freshDatabase();
  rescue = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('harbor-paws', 'Harbor Paws', 'animal', true) returning id")).rows[0].id;
  pantry = (await db.query("insert into public.nonprofits (slug, name, is_live) values ('pantry', 'Pantry', true) returning id")).rows[0].id;
  await db.query(`
    insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status, stripe_subscription_id) values
      ($1, 'Sarah', 'Sarah@Example.com', 2500, 'active', 'sub_1'),
      ($2, 'Sarah', 'sarah@example.com', 1500, 'past_due', 'sub_2'),
      ($1, 'Sara', 'sara_h@example.com', 2500, 'active', 'sub_3'),
      ($1, 'Sam', 'saraXh@example.com', 2500, 'active', 'sub_4')
  `, [rescue, pantry]);
  await db.query("insert into auth.users (id) values ($1)", [OWNER]);
});

after(async () => {
  await db?.close();
});

test("every gift for an email, ignoring case and spaces, with no wildcard surprises", async () => {
  const gifts = (await server("select first_name, monthly_cents from public.gifts_for_email($1)", ["  SARAH@example.com "])).rows;
  assert.equal(gifts.length, 2);
  const underscore = (await server("select email from public.gifts_for_email($1)", ["sara_h@example.com"])).rows;
  assert.deepEqual(underscore.map((r) => r.email), ["sara_h@example.com"], "an underscore is a real character, not 'any letter'");
  assert.equal((await server("select * from public.gifts_for_email($1)", ["nobody@example.com"])).rows.length, 0);
});

test("only Cover's server can look gifts up by email", async () => {
  await assert.rejects(runAs(db, "anon", null, "select * from public.gifts_for_email('sarah@example.com')"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select * from public.gifts_for_email('sarah@example.com')"), /permission denied/);
  await assert.rejects(runAs(db, "anon", null, "select public.manage_link_rate_check($1, $2)", [hash(1), hash(2)]), /permission denied/);
});

test("link requests: 3 an hour per email, 10 an hour per IP", async () => {
  for (let i = 0; i < 3; i += 1) assert.equal(await check("ip-a", "one@example.com"), "ok");
  assert.equal(await check("ip-a", "one@example.com"), "email");
  assert.equal(await check("ip-b", "one@example.com"), "email", "a new IP doesn't reset the email's limit");
  for (let i = 0; i < 6; i += 1) assert.equal(await check("ip-c", `person${i}@example.com`), "ok");
  for (let i = 6; i < 10; i += 1) assert.equal(await check("ip-c", `person${i}@example.com`), "ok");
  assert.equal(await check("ip-c", "person10@example.com"), "ip");
  await assert.rejects(server("select public.manage_link_rate_check('1.2.3.4', 'a@b.co')"), /check constraint/, "only hashes are stored");
});

test("link emails are logged without a nonprofit; other emails still need one", async () => {
  await server("insert into public.sponsor_emails (nonprofit_id, kind, status) values (null, 'manage_link', 'sent')");
  await assert.rejects(server("insert into public.sponsor_emails (nonprofit_id, kind, status) values (null, 'update', 'sent')"), /sponsor_emails_nonprofit_check/);
  await server("insert into public.sponsor_emails (nonprofit_id, kind, status) values ($1, 'update', 'sent')", [rescue]);
  await assert.rejects(server("insert into public.sponsor_emails (nonprofit_id, kind, status) values ($1, 'newsletter', 'sent')", [rescue]), /sponsor_emails_kind_check/);
  const sentToday = (await server("select count(*)::int as n from public.sponsor_emails where status = 'sent'")).rows[0].n;
  assert.equal(sentToday, 2, "link emails count toward the daily budget");
});

test("the card-update settings id must look like Stripe's", async () => {
  await server("update public.nonprofits set stripe_portal_config = 'bpc_1AbC' where id = $1", [rescue]);
  await assert.rejects(server("update public.nonprofits set stripe_portal_config = 'nope' where id = $1", [rescue]), /check constraint/);
});
