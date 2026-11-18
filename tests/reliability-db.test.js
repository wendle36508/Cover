// Tests for the reliability migration: checkout rate limits, the Stripe re-sync tables, and the
// admin-only health numbers for Cover HQ. Run with: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const ADMIN = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
const hash = (text) => createHash("sha256").update(String(text)).digest("hex");

let db;
const server = (sql, params) => runAs(db, "service_role", null, sql, params);
const check = async (ip, email) => (await server("select public.checkout_rate_check($1, $2) as v", [hash(ip), hash(email)])).rows[0].v;

before(async () => {
  db = await freshDatabase();
  await db.query("insert into auth.users (id) values ($1), ($2)", [ADMIN, OWNER]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [ADMIN]);
});

after(async () => {
  await db?.close();
});

test("only Cover's server can run the rate check", async () => {
  await assert.rejects(runAs(db, "anon", null, "select public.checkout_rate_check($1, $2)", [hash(1), hash(2)]), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select public.checkout_rate_check($1, $2)", [hash(1), hash(2)]), /permission denied/);
});

test("one email gets 5 tries an hour, then is held back", async () => {
  for (let i = 0; i < 5; i += 1) assert.equal(await check(`a${i}`, "e"), "ok");
  assert.equal(await check("a9", "e"), "email");
  assert.equal(await check("a9", "f"), "ok", "a different email from that IP is fine");
});

test("one IP gets 10 tries an hour", async () => {
  for (let i = 0; i < 10; i += 1) assert.equal(await check("b", `m${i}`), "ok");
  assert.equal(await check("b", "m99"), "ip");
});

test("old attempts don't count and get cleaned up", async () => {
  await db.query("update private.checkout_attempts set created_at = now() - interval '3 days' where ip_hash = $1", [hash("b")]);
  assert.equal(await check("b", "fresh"), "ok");
  const { rows } = await db.query("select count(*)::int as n from private.checkout_attempts where created_at < now() - interval '2 days'");
  assert.equal(rows[0].n, 0);
});

test("the attempts table never stores a real IP or email", async () => {
  await assert.rejects(server("select public.checkout_rate_check('203.0.113.9', 'sarah@example.com')"), /check constraint/);
});

test("HQ health numbers are admin-only and count the right things", async () => {
  const np = (await db.query("insert into public.nonprofits (slug, name, is_live) values ('rescue', 'Rescue', true) returning id")).rows[0].id;
  const sponsor = (await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status) values ($1, 'Sarah', 's@example.com', 2500, 'active') returning id", [np])).rows[0].id;
  await db.query("insert into public.sponsor_emails (nonprofit_id, sponsor_id, kind, status) values ($1, $2, 'update', 'sent'), ($1, $2, 'update', 'sent'), ($1, $2, 'update', 'failed')", [np, sponsor]);
  await db.query("insert into public.sponsor_emails (nonprofit_id, sponsor_id, kind, status, created_at) values ($1, $2, 'update', 'sent', now() - interval '2 days')", [np, sponsor]);
  await db.query("insert into public.stripe_sync_runs (checked, fixed, errors, finished_at) values (4, 1, 0, now())");
  const issue = (await db.query("insert into public.stripe_sync_issues (sponsor_id, nonprofit_id, kind, cover_status, stripe_status) values ($1, $2, 'status_fixed', 'active', 'canceled') returning id", [sponsor, np])).rows[0].id;

  const health = (await runAs(db, "authenticated", ADMIN, "select public.admin_reliability() as h")).rows[0].h;
  assert.equal(health.emails_sent_today, 2);
  assert.equal(health.emails_failed_24h, 1);
  assert.equal(health.checkout_blocked_24h, 1, "the IP block from the earlier test was cleaned up with its old attempts");
  assert.equal(health.last_sync.fixed, 1);
  assert.deepEqual(health.open_issues.map((i) => [i.kind, i.sponsor, i.nonprofit]), [["status_fixed", "Sarah", "Rescue"]]);

  await assert.rejects(runAs(db, "authenticated", OWNER, "select public.admin_reliability()"), /Only Cover admins/);
  await assert.rejects(runAs(db, "anon", null, "select public.admin_reliability()"), /permission denied/);
  await assert.rejects(runAs(db, "anon", null, "select * from public.stripe_sync_issues"), /permission denied/);

  await runAs(db, "authenticated", ADMIN, "select public.admin_resolve_sync_issue($1)", [issue]);
  const after = (await runAs(db, "authenticated", ADMIN, "select public.admin_reliability() as h")).rows[0].h;
  assert.deepEqual(after.open_issues, []);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select public.admin_resolve_sync_issue($1)", [issue]), /Only Cover admins/);
});

test("waiting adoption notes are private to Cover's server and counted in HQ", async () => {
  const np = (await db.query("select id from public.nonprofits where slug = 'rescue'")).rows[0].id;
  await db.query(`insert into public.queued_emails (nonprofit_id, kind, to_email, from_line, subject, html, text_body, stop_url, send_after)
    values ($1, 'adopted', 's@example.com', 'Rescue via Cover <hello@covergiving.com>', 'Bella went home!', '<p>x</p>', 'x', 'https://covergiving.com/updates.html?a=stop&t=x', now() + interval '1 day')`, [np]);
  await assert.rejects(runAs(db, "anon", null, "select * from public.queued_emails"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", OWNER, "select * from public.queued_emails"), /permission denied/);
  const health = (await runAs(db, "authenticated", ADMIN, "select public.admin_reliability() as h")).rows[0].h;
  assert.equal(health.updates_held, 1);
  await assert.rejects(db.query("insert into public.queued_emails (nonprofit_id, kind, to_email, from_line, subject, html, text_body, stop_url, send_after) values ($1, 'spam', 'a', 'b', 'c', 'd', 'e', 'f', now())", [np]), /check constraint/);
});

