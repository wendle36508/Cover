// Tests for signing in on the computer by opening the emailed link on a phone (Nov 25, 2026):
// the helpers in supabase/functions/_shared/link-wait.js, the sign_in_waits table, and the wiring in the
// sponsor-portal function and the My sponsorships page. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";

import {
  POLL_SECONDS, WAIT_MINUTES, cleanWaitId, cleanWaitSecret, linkWithWait, newWaitCode, sameText, sha256Hex, waitState,
} from "../supabase/functions/_shared/link-wait.js";
import { freshDatabase, runAs } from "./support/database.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const WAIT_ID = "3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b";
const MINUTE = 60000;

test("the computer's secret must be long and plain", () => {
  const good = "a".repeat(43);
  assert.equal(cleanWaitSecret(good), good);
  assert.equal(cleanWaitSecret("Ab0_-".repeat(8)), "Ab0_-".repeat(8));
  assert.equal(cleanWaitSecret("short"), null, "too short to be random");
  assert.equal(cleanWaitSecret("a".repeat(129)), null, "too long");
  assert.equal(cleanWaitSecret("a".repeat(40) + "+/="), null, "only URL-safe characters");
  assert.equal(cleanWaitSecret(""), null);
  assert.equal(cleanWaitSecret(undefined), null);
  assert.equal(cleanWaitSecret(12345678901234567890123456789012345), null);
});

test("a waiting sign-in's id must look like one", () => {
  assert.equal(cleanWaitId(WAIT_ID), WAIT_ID);
  assert.equal(cleanWaitId(WAIT_ID.toUpperCase()), WAIT_ID, "case doesn't matter");
  assert.equal(cleanWaitId("not-an-id"), null);
  assert.equal(cleanWaitId(`${WAIT_ID}' or 1=1`), null);
  assert.equal(cleanWaitId(null), null);
});

test("the number is always 4 digits", () => {
  assert.equal(newWaitCode(0), "0000");
  assert.equal(newWaitCode(7), "0007");
  assert.equal(newWaitCode(4821), "4821");
  assert.equal(newWaitCode(4294967295), "7295", "the biggest random number still gives 4 digits");
  for (let i = 0; i < 200; i += 1) assert.match(newWaitCode(), /^[0-9]{4}$/);
});

test("Cover keeps only a scrambled copy of the secret", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(await sha256Hex("anything"), /^[0-9a-f]{64}$/);
  assert.notEqual(await sha256Hex("a"), await sha256Hex("b"));
});

test("comparing the scrambled copies", () => {
  assert.equal(sameText("abc", "abc"), true);
  assert.equal(sameText("abc", "abd"), false);
  assert.equal(sameText("abc", "abcd"), false);
  assert.equal(sameText("", ""), true);
  assert.equal(sameText(null, "x"), false);
});

test("where a waiting sign-in stands", () => {
  const now = new Date("2026-11-25T18:00:00Z");
  const made = (minutesAgo, more = {}) => ({ created_at: new Date(now - minutesAgo * MINUTE).toISOString(), approved_at: null, used_at: null, ...more });
  assert.equal(waitState(made(1), now), "waiting");
  assert.equal(waitState(made(1, { approved_at: now.toISOString() }), now), "approved");
  assert.equal(waitState(made(1, { approved_at: now.toISOString(), used_at: now.toISOString() }), now), "used");
  assert.equal(waitState(made(WAIT_MINUTES - 0.5), now), "waiting", "just inside 15 minutes");
  assert.equal(waitState(made(WAIT_MINUTES + 0.5), now), "expired");
  assert.equal(waitState(made(WAIT_MINUTES + 1, { approved_at: now.toISOString() }), now), "expired", "a late yes doesn't count");
  assert.equal(waitState(null, now), "expired");
  assert.equal(POLL_SECONDS, 3);
});

test("the emailed link names the waiting sign-in, or stays as it was", () => {
  const url = "https://covergiving.com/gifts.html?t=abc.def";
  assert.equal(linkWithWait(url, WAIT_ID), `${url}&w=${WAIT_ID}`);
  assert.equal(linkWithWait(url, null), url);
  assert.equal(linkWithWait(url, undefined), url);
});

// ---------- The table ----------

let db;
before(async () => {
  db = await freshDatabase();
});
after(async () => {
  await db?.close();
});

const insertWait = (fields = {}) => db.query(
  "insert into public.sign_in_waits (email, secret_hash, code) values ($1, $2, $3) returning *",
  [fields.email ?? "sarah@example.com", fields.secret_hash ?? "a".repeat(64), fields.code ?? "4821"],
);

test("the table holds a scrambled secret and a 4-digit number", async () => {
  const row = (await insertWait()).rows[0];
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.equal(row.approved_at, null);
  assert.equal(row.used_at, null);
  await assert.rejects(insertWait({ secret_hash: "not a hash" }), /check/);
  await assert.rejects(insertWait({ code: "123" }), /check/);
  await assert.rejects(insertWait({ code: "12a4" }), /check/);
  await assert.rejects(insertWait({ email: "x" }), /check/);
});

test("nobody but Cover's server can read or change it", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(runAs(db, role, null, "select * from public.sign_in_waits"), /permission denied/);
    await assert.rejects(runAs(db, role, null, "insert into public.sign_in_waits (email, secret_hash, code) values ('a@b.co', repeat('a', 64), '1234')"), /permission denied/);
  }
});

// ---------- Wiring ----------

test("the server: asks for a secret, checks the email on the phone, hands out a sign-in once", () => {
  const ts = read("../supabase/functions/sponsor-portal/index.ts");
  assert.match(ts, /const waitSecret = cleanWaitSecret\(body\.waitSecret\);/);
  assert.match(ts, /secret_hash: await sha256Hex\(waitSecret\)/, "only the scrambled copy is stored");
  assert.ok(ts.indexOf("const waitSecret") < ts.indexOf("if (!visibleSponsorships(await giftsFor(email)).length) return answer;"),
    "made before the 'nobody to email' check, so the answer never shows whether the email gives through Cover");
  assert.match(ts, /linkWithWait\(manageUrl\(/);
  assert.match(ts, /normalizeEmail\(wait\.email\) !== email/, "the phone's link must be for the same email");
  assert.match(ts, /\.is\("used_at", null\)/, "handed out only once");
  assert.match(ts, /case "wait_info":/);
  assert.match(ts, /case "approve_wait":/);
  assert.match(ts, /case "check_wait":/);
});

test("the page: shows the number, checks every few seconds, asks the phone before signing in the computer", () => {
  const js = read("../docs/js/gifts.js");
  assert.match(js, /waitSecret: secret/);
  assert.match(js, /call\("check_wait", \{ wait, secret \}\)/);
  assert.match(js, /const POLL_MS = 3000;/);
  assert.match(js, /const WAIT_MS = 15 \* 60000;/);
  assert.match(js, /"Sign in on your computer too\?"/);
  assert.match(js, /"No, that wasn't me"/);
  assert.match(js, /if \(waitFromLink && picked\.fromLink && !demo\) offerOtherComputer\(waitFromLink\);/);
  assert.ok(js.indexOf('get("w")') < js.indexOf("history.replaceState"), "reads the w before the address is cleaned up");
  assert.match(read("../docs/gifts.html"), /js\/gifts\.js\?v=20261125g/);
});
