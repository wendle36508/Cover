// Tests for the insights migration: the walled-off schema, the secret-protected importer functions,
// safe cleanup after a run, and the admin-only HQ functions. Run with: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const ADMIN = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
const SECRET = "s".repeat(40);

let db;
const anon = (sql, params) => runAs(db, "anon", null, sql, params);
const as = (userId, sql, params) => runAs(db, "authenticated", userId, sql, params);
const org = (ein, revenue = 100000) => [ein, `Org ${ein}`, "Portland", "ME", "04101", "D20", "15", 2001, revenue, 5000, 120000, "202406"];
const start = async (source) => (await anon("select public.insights_import_start($1, $2, '2026-11-10') as t", [SECRET, source])).rows[0].t;
const load = (fn, rows) => anon(`select public.insights_import_${fn}($1, $2::jsonb) as n`, [SECRET, JSON.stringify(rows)]);
const cleanup = async (source, started) => {
  let total = 0;
  for (;;) {
    const n = (await anon("select public.insights_import_cleanup($1, $2, $3) as n", [SECRET, source, started])).rows[0].n;
    if (!n) return total;
    total += n;
  }
};
const count = async (sql) => (await db.query(sql)).rows[0].n;

before(async () => {
  db = await freshDatabase();
  const hash = createHash("sha256").update(SECRET).digest("hex");
  await db.query("insert into insights.import_keys (hash) values ($1)", [hash]);
  await db.query("insert into auth.users (id) values ($1), ($2)", [ADMIN, OWNER]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [ADMIN]);
});

after(async () => {
  await db?.close();
});

test("the website can't read the insights tables at all", async () => {
  await assert.rejects(anon("select * from insights.orgs"), /permission denied/);
  await assert.rejects(as(OWNER, "select * from insights.benchmarks"), /permission denied/);
});

test("the importer functions need the secret", async () => {
  for (const bad of [null, "short", "x".repeat(40)]) {
    await assert.rejects(anon("select public.insights_import_start($1, 'irs_bmf', '2026-11-10')", [bad]), /Not allowed/);
    await assert.rejects(anon("select public.insights_import_orgs($1, '[]'::jsonb)", [bad]), /Not allowed/);
  }
  await assert.rejects(anon("select public.insights_import_start($1, 'nope', '2026-11-10')", [SECRET]), /Unknown source/);
});

test("a registry run loads rows, updates them on the next run, and removes ones that left", async () => {
  let started = await start("irs_bmf");
  await load("orgs", [org("000000001"), org("000000002"), org("000000003", 7000000)]);
  assert.equal(await cleanup("irs_bmf", started), 0);
  await anon("select public.insights_import_finish($1, 'irs_bmf', true, null)", [SECRET]);
  assert.equal(await count("select count(*)::int as n from insights.orgs"), 3);

  started = await start("irs_bmf");
  await load("orgs", [org("000000001", 250000), org("000000002"), org("000000004")]);
  assert.equal(await cleanup("irs_bmf", started), 1, "000000003 left the IRS file");
  const rows = (await db.query("select ein, revenue from insights.orgs order by ein")).rows;
  assert.deepEqual(rows.map((r) => [r.ein, Number(r.revenue)]), [["000000001", 250000], ["000000002", 100000], ["000000004", 100000]]);
});

test("a half-failed run never wipes good data", async () => {
  const started = await start("irs_bmf");
  await load("orgs", [org("000000001")]); // only 1 of 3 rows came through
  assert.equal(await cleanup("irs_bmf", started), 0);
  assert.equal(await count("select count(*)::int as n from insights.orgs"), 3);
  await anon("select public.insights_import_finish($1, 'irs_bmf', false, 'download cut off')", [SECRET]);
  const run = (await db.query("select status, note from insights.imports where source = 'irs_bmf'")).rows[0];
  assert.deepEqual(run, { status: "failed", note: "download cut off" });
});

test("Pub 78 and 990-N only touch orgs already in the registry, and stale Pub 78 codes clear", async () => {
  let started = await start("irs_pub78");
  await load("pub78", [["000000001", "PC"], ["000000002", "PC"], ["999999999", "PF"]]);
  await cleanup("irs_pub78", started);
  assert.equal(await count("select count(*)::int as n from insights.orgs where pub78_codes is not null"), 2);
  assert.equal(await count("select count(*)::int as n from insights.orgs where ein = '999999999'"), 0);

  started = await start("irs_pub78");
  await load("pub78", [["000000001", "PC"], ["000000004", "PC"]]);
  assert.equal(await cleanup("irs_pub78", started), 1, "000000002 dropped off Pub 78");

  await start("irs_990n");
  await load("990n", [["000000004", 2025], ["888888888", 2024]]);
  assert.equal(await count("select last_990n_year as n from insights.orgs where ein = '000000004'"), 2025);
});

test("revocations load and the admin EIN check reports good standing", async () => {
  await start("irs_revocations");
  await load("revocations", [["000000002", "2020-05-15", null], ["777777777", "2019-01-01", "2021-03-01"]]);
  const check = async (ein) => (await as(ADMIN, "select public.admin_check_ein($1) as r", [ein])).rows[0].r;
  assert.equal((await check("00-0000001")).status, "good");
  assert.equal((await check("000000002")).status, "revoked");
  assert.equal((await check("000000004")).status, "good");
  assert.equal((await check("123456789")).status, "not_found");
  assert.equal((await check("12")).status, "bad_ein");
  const reinstated = await check("777777777");
  assert.equal(reinstated.status, "not_found", "reinstated orgs aren't flagged as revoked");
});

test("HQ status and benchmarks are admin-only", async () => {
  const status = (await as(ADMIN, "select public.admin_insights_status() as s")).rows[0].s;
  assert.equal(status.orgs, 3);
  assert.equal(status.prospects, 3);
  assert.equal(status.benchmarks.length, 15);
  assert.ok(status.benchmarks.every((b) => b.source_url.startsWith("https://")));
  await assert.rejects(as(OWNER, "select public.admin_insights_status()"), /Only Cover admins/);
  await assert.rejects(anon("select public.admin_insights_status()"), /permission denied/);
});

test("admins can edit a benchmark; bad links and ids are refused", async () => {
  const item = { id: "fep_retention_ytd", label: "Donor retention", value: "27%", definition: "d", source_name: "FEP Q3", source_url: "https://example.org", as_of: "2027-01-28", sort_order: 10 };
  await as(ADMIN, "select public.admin_save_benchmark($1::jsonb)", [JSON.stringify(item)]);
  const row = (await db.query("select value, source_name from insights.benchmarks where id = 'fep_retention_ytd'")).rows[0];
  assert.deepEqual(row, { value: "27%", source_name: "FEP Q3" });
  await assert.rejects(as(ADMIN, "select public.admin_save_benchmark($1::jsonb)", [JSON.stringify({ ...item, source_url: "javascript:alert(1)" })]), /check constraint/);
  await assert.rejects(as(ADMIN, "select public.admin_save_benchmark($1::jsonb)", [JSON.stringify({ ...item, id: "Bad Id!" })]), /check constraint/);
  await assert.rejects(as(OWNER, "select public.admin_save_benchmark($1::jsonb)", [JSON.stringify(item)]), /Only Cover admins/);
});
