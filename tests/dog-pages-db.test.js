// Tests for the dog pages migration: the longer story and extra photos on each dog, their limits,
// and who can see them. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const OWNER = "11111111-1111-1111-1111-111111111111";
let db;
let live;
let hidden;

before(async () => {
  db = await freshDatabase();
  live = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('lucky', 'Lucky Pup', 'animal', true) returning id")).rows[0].id;
  hidden = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('hidden', 'Hidden', 'animal', false) returning id")).rows[0].id;
  await db.query("insert into auth.users (id) values ($1)", [OWNER]);
  await db.query("insert into public.staff (user_id, nonprofit_id, role) values ($1, $2, 'owner'), ($1, $3, 'owner')", [OWNER, live, hidden]);
});

after(async () => {
  await db?.close();
});

const asOwner = (sql, params) => runAs(db, "authenticated", OWNER, sql, params);

test("staff can add a longer story and up to 6 https photos", async () => {
  const photos = Array.from({ length: 6 }, (_, i) => `https://x.supabase.co/storage/v1/object/public/photos/${i}.jpg`);
  await asOwner("insert into public.follow_items (nonprofit_id, name, story, more_photos) values ($1, 'Burt', $2, $3)", [live, "A".repeat(1200), photos]);
  const row = (await db.query("select story, more_photos from public.follow_items where name = 'Burt'")).rows[0];
  assert.equal(row.story.length, 1200);
  assert.equal(row.more_photos.length, 6);
});

test("too long, too many, or unsafe photo links are refused", async () => {
  await assert.rejects(asOwner("insert into public.follow_items (nonprofit_id, name, story) values ($1, 'Long', $2)", [live, "A".repeat(1201)]), /check constraint/);
  await assert.rejects(asOwner("insert into public.follow_items (nonprofit_id, name, more_photos) values ($1, 'Many', $2)", [live, Array.from({ length: 7 }, (_, i) => `https://x/${i}.jpg`)]), /check constraint/);
  for (const bad of ["javascript:alert(1)", "http://x/a.jpg", 'https://x/a".jpg', `https://${"a".repeat(500)}.jpg`]) {
    await assert.rejects(asOwner("insert into public.follow_items (nonprofit_id, name, more_photos) values ($1, 'Bad', $2)", [live, [bad]]), /check constraint/, bad);
  }
  const plain = (await asOwner("insert into public.follow_items (nonprofit_id, name) values ($1, 'Plain') returning more_photos, story", [live])).rows[0];
  assert.deepEqual([plain.more_photos, plain.story], [[], null], "both are optional");
});

test("visitors see the story and photos on live pages only", async () => {
  await db.query("insert into public.follow_items (nonprofit_id, name, story) values ($1, 'Secret', 'Not yet')", [hidden]);
  const seen = (await runAs(db, "anon", null, "select name, story, more_photos from public.follow_items where name in ('Burt', 'Secret')")).rows;
  assert.deepEqual(seen.map((r) => r.name), ["Burt"]);
  assert.equal((await asOwner("select story from public.follow_items where name = 'Secret'")).rows[0].story, "Not yet", "staff see their hidden page");
  await assert.rejects(runAs(db, "anon", null, "update public.follow_items set story = 'hacked' where name = 'Burt'"), /permission denied/);
});
