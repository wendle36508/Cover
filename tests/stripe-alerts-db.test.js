// Tests for the stripe_alerts_gift_set migration: alerts stay private, the email queue takes the new kind,
// gift buyers are included in the welcome job, and HQ shows what Stripe needs. Run with: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { freshDatabase, runAs } from "./support/database.js";

const ADMIN = "11111111-1111-1111-1111-111111111111";
let db;
let nonprofit;

before(async () => {
  db = await freshDatabase();
  nonprofit = (await db.query("insert into public.nonprofits (slug, name, kind, is_live) values ('lucky', 'Lucky Pup', 'animal', true) returning id")).rows[0].id;
  await db.query("insert into auth.users (id) values ($1)", [ADMIN]);
  await db.query("insert into public.cover_admins (user_id) values ($1)", [ADMIN]);
});

after(async () => {
  await db?.close();
});

test("Stripe alerts are private: visitors and signed-in people can't read them", async () => {
  await db.query("insert into public.stripe_alerts (nonprofit_id, key, message) values ($1, 'company.tax_id', 'Stripe needs one more thing.')", [nonprofit]);
  await assert.rejects(runAs(db, "anon", null, "select * from public.stripe_alerts"), /permission denied/);
  await assert.rejects(runAs(db, "authenticated", ADMIN, "select * from public.stripe_alerts"), /permission denied/);
});

test("HQ shows what Stripe needs next to the nonprofit", async () => {
  const overview = (await runAs(db, "authenticated", ADMIN, "select public.admin_overview() as o")).rows[0].o;
  assert.equal(overview.nonprofits.find((n) => n.id === nonprofit).stripe_alert, "Stripe needs one more thing.");
  assert.ok("new_page" in overview.nonprofits[0], "everything HQ showed before is still there");
});

test("the email queue and log take the new kinds", async () => {
  await db.query("insert into public.queued_emails (nonprofit_id, kind, to_email, from_line, subject, html, text_body, stop_url, send_after) values ($1, 'stripe_alert', 'owner@example.com', 'Cover', 's', 'h', 't', '', now())", [nonprofit]);
  await db.query("insert into public.sponsor_emails (nonprofit_id, kind, status) values ($1, 'stripe_alert', 'sent'), ($1, 'gift_set', 'sent')", [nonprofit]);
  await assert.rejects(db.query("insert into public.queued_emails (nonprofit_id, kind, to_email, from_line, subject, html, text_body, stop_url, send_after) values ($1, 'spam', 'a@b.co', 'C', 's', 'h', 't', '', now())", [nonprofit]), /check constraint/);
});

test("a gift's buyer is in the welcome job (they get \"your gift is set\")", async () => {
  await db.query("insert into public.sponsors (nonprofit_id, first_name, email, monthly_cents, status, gift_name, gift_email, gift_send_on) values ($1, 'Sarah', 'sarah@example.com', 2500, 'active', 'Linda', 'linda@example.com', '2026-12-25'), ($1, 'Sam', 'sam@example.com', 2500, 'active', null, null, null)", [nonprofit]);
  const due = (await db.query("select first_name from public.welcome_emails_due(50) order by first_name")).rows.map((r) => r.first_name);
  assert.deepEqual(due, ["Sam", "Sarah"]);
});
