// Tests for the profile_fields migration (new sponsor pages): facts, groups and the profile's extra
// lines, with their limits. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
let db;
let nonprofit;

before(async () => {
  db = await freshDatabase();
  nonprofit = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('lucky', 'Lucky Pup', 'animal', true) returning id")).rows[0].id;
  await db.query("insert into auth.users (id) values ($1)", [OWNER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner')", [OWNER, nonprofit]);
});

after(async () => {
  await db?.close();
});

const add = (name, columns) => runAs(db, "authenticated", OWNER,
  `insert into public.follow_items (nonprofit_id, name, ${Object.keys(columns).join(", ")}) values ($1, $2, ${Object.keys(columns).map((_, i) => `$${i + 3}`).join(", ")}) returning *`,
  [nonprofit, name, ...Object.values(columns)]);

test("staff can add facts, a group, and the profile's lines", async () => {
  const row = (await add("Burt", { facts: JSON.stringify({ Age: "1½ years", Breed: "Terrier mix", Sex: "Male" }), why: "Learning leash manners.", loves: "Climbing", dislikes: "Waiting" })).rows[0];
  assert.deepEqual(row.facts, { Age: "1½ years", Breed: "Terrier mix", Sex: "Male" });
  assert.equal(row.is_group, false);
  const group = (await add("Golden Oldies", { is_group: true })).rows[0];
  assert.deepEqual([group.is_group, group.facts, group.why], [true, {}, null], "everything else is optional");
});

test("facts must be a short list of short words", async () => {
  const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`F${i}`, "x"]));
  for (const [label, facts] of [["a list", ["Age"]], ["a number", { Age: 3 }], ["too many", tooMany], ["long value", { Age: "a".repeat(41) }], ["long name", { ["a".repeat(31)]: "x" }], ["empty name", { "": "x" }]]) {
    await assert.rejects(add(`Bad ${label}`, { facts: JSON.stringify(facts) }), /check constraint/, label);
  }
});

test("the profile lines have limits", async () => {
  await assert.rejects(add("Long why", { why: "a".repeat(601) }), /check constraint/);
  await assert.rejects(add("Long love", { loves: "a".repeat(121) }), /check constraint/);
  await assert.rejects(add("Long dislike", { dislikes: "a".repeat(121) }), /check constraint/);
});

test("visitors can read them on live pages, but not change them", async () => {
  const seen = (await runAs(db, "anon", null, "select facts, why from public.follow_items where name = 'Burt'")).rows[0];
  assert.equal(seen.facts.Sex, "Male");
  await assert.rejects(runAs(db, "anon", null, "update public.follow_items set why = 'hacked'"), /permission denied/);
});
