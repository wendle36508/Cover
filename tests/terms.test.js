// Tests for Terms of Service agreements: the browser helper (docs/js/terms.js) and the database
// record (record_terms_acceptance). Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { agreedVersion, recordTermsAgreement, rememberTermsAgreement, TERMS_VERSION } from "../docs/js/terms.js";
import { freshDatabase, runAs } from "./support/database.js";

const USER = "55555555-5555-5555-5555-555555555555";
const OTHER = "66666666-6666-6666-6666-666666666666";
let db;

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

before(async () => {
  db = await freshDatabase();
  await db.query("insert into auth.users (id, email) values ($1, 'ann@example.com'), ($2, 'bo@example.com')", [USER, OTHER]);
});

after(async () => {
  await db?.close();
});

test("the box being checked is remembered in this browser", () => {
  const storage = memoryStorage();
  assert.equal(agreedVersion(null, storage), null);
  rememberTermsAgreement(storage);
  assert.equal(agreedVersion(null, storage), TERMS_VERSION);
});

test("a new account carries the version even on another device", () => {
  assert.equal(agreedVersion({ user_metadata: { terms_version: "2026-11-14" } }, memoryStorage()), "2026-11-14");
  assert.equal(agreedVersion({ user_metadata: { terms_version: "<script>" } }, memoryStorage()), null);
});

test("blocked storage doesn't break anything", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.doesNotThrow(() => rememberTermsAgreement(broken));
  assert.equal(agreedVersion(null, broken), null);
});

test("after sign-in the agreement is saved once, then the browser note is cleared", async () => {
  const storage = memoryStorage();
  rememberTermsAgreement(storage);
  const calls = [];
  const fake = { rpc: async (name, args) => { calls.push([name, args]); return { error: null }; } };
  assert.equal(await recordTermsAgreement(fake, null, storage), true);
  assert.deepEqual(calls, [["record_terms_acceptance", { accepted_version: TERMS_VERSION }]]);
  assert.equal(agreedVersion(null, storage), null);
  assert.equal(await recordTermsAgreement(fake, null, storage), false, "nothing left to record");
});

test("the database records who agreed, once per version", async () => {
  await runAs(db, "authenticated", USER, "select public.record_terms_acceptance('2026-11-14')");
  await runAs(db, "authenticated", USER, "select public.record_terms_acceptance('2026-11-14')");
  const { rows } = await db.query("select user_id, version, email from public.terms_acceptances");
  assert.deepEqual(rows, [{ user_id: USER, version: "2026-11-14", email: "ann@example.com" }]);
});

test("nobody can record for someone else or read others' agreements", async () => {
  await assert.rejects(runAs(db, "anon", null, "select public.record_terms_acceptance('2026-11-14')"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", USER, "select public.record_terms_acceptance('nope')"), /Unknown terms version/);
  await assert.rejects(runAs(db, "authenticated", USER, "insert into public.terms_acceptances (user_id, version) values ($1, '2026-11-14')", [OTHER]), /permission denied/);
  assert.equal((await runAs(db, "authenticated", OTHER, "select * from public.terms_acceptances")).rows.length, 0);
  assert.equal((await runAs(db, "authenticated", USER, "select * from public.terms_acceptances")).rows.length, 1);
});
