// stripe-webhook - Stripe calls this when something happens to a payment on a nonprofit's account:
// a gift went through, a card failed, a sponsor canceled, a refund or dispute. Also when a nonprofit's
// Stripe account itself changes (account.updated): its page turns on or off to match, and if Stripe
// needs something, the owner and Cover get one plain-English email (Nov 25, 2026).
// Every message's signature is checked with the webhook secret before anything is trusted.
// Each event is logged once (Stripe can resend), then sponsor statuses are updated.

import Stripe from "npm:stripe@23";
import { adminDatabase, json, requireSetting, stripeClient } from "../_shared/clients.ts";
import { accountHealth } from "../_shared/connect.js";
import { fromLine, SITE_URL, stripeAlertEmail } from "../_shared/email.js";
import { changesForEvent } from "../_shared/sponsorship.js";

const cryptoProvider = Stripe.createSubtleCryptoProvider();
type Db = ReturnType<typeof adminDatabase>;

/** Everyone who should hear that Stripe needs something: the nonprofit's owners (or invited owner) and Cover's admins. */
async function alertRecipients(db: Db, nonprofitId: string): Promise<string[]> {
  const [{ data: owners }, { data: invites }, { data: admins }] = await Promise.all([
    db.from("staff").select("user_id").eq("nonprofit_id", nonprofitId).eq("role", "owner"),
    db.from("staff_invites").select("email").eq("nonprofit_id", nonprofitId).eq("role", "owner"),
    db.from("cover_admins").select("user_id"),
  ]);
  const ids = [...(owners ?? []), ...(admins ?? [])].map((row) => row.user_id);
  const emails = await Promise.all(ids.map(async (id) => (await db.auth.admin.getUserById(id)).data.user?.email ?? ""));
  return [...new Set([...emails, ...(invites ?? []).map((row) => row.email)].map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

/** A nonprofit's Stripe account changed: match its page to it, and email once about anything Stripe needs. */
async function accountUpdated(db: Db, event: Stripe.Event) {
  const account = event.data.object as Stripe.Account;
  const { data: nonprofit, error } = await db.from("nonprofits").select("id, name, is_live")
    .eq("stripe_account_id", event.account ?? account.id).maybeSingle();
  if (error) throw error;
  if (!nonprofit) return; // not one of Cover's nonprofits
  const health = accountHealth(account);
  if (health.live !== nonprofit.is_live) {
    const { error: liveError } = await db.from("nonprofits").update({ is_live: health.live }).eq("id", nonprofit.id);
    if (liveError) throw liveError;
    console.log("Page turned", health.live ? "on" : "off", "to match Stripe:", nonprofit.id);
  }
  if (!health.problem) {
    await db.from("stripe_alerts").delete().eq("nonprofit_id", nonprofit.id);
    return;
  }
  const { data: known } = await db.from("stripe_alerts").select("key").eq("nonprofit_id", nonprofit.id).maybeSingle();
  if (known?.key === health.key) return; // already told them about exactly this
  const { error: alertError } = await db.from("stripe_alerts")
    .upsert({ nonprofit_id: nonprofit.id, key: health.key, message: health.problem, raised_at: new Date().toISOString() });
  if (alertError) throw alertError;
  const email = stripeAlertEmail({ nonprofitName: nonprofit.name, problem: health.problem, dashboardUrl: `${SITE_URL}/dashboard.html#${health.live ? "payments" : "connect"}` });
  const rows = (await alertRecipients(db, nonprofit.id)).map((to) => ({
    nonprofit_id: nonprofit.id, kind: "stripe_alert", to_email: to, from_line: fromLine("Cover"), subject: email.subject,
    html: email.html, text_body: email.text, stop_url: "", send_after: new Date().toISOString(),
  }));
  // Sent by the 15-minute email job, inside the same daily email budget as everything else.
  if (rows.length) {
    const { error: queueError } = await db.from("queued_emails").insert(rows);
    if (queueError) throw queueError;
  }
}

Deno.serve(async (request) => {
  if (request.method === "GET") return json({ ok: true, service: "stripe-webhook" }, 200); // uptime monitor
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const signature = request.headers.get("Stripe-Signature");
  if (!signature) return json({ error: "Missing Stripe signature." }, 400);

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = await stripeClient().webhooks.constructEventAsync(
      payload,
      signature,
      requireSetting("STRIPE_WEBHOOK_SECRET"),
      undefined,
      cryptoProvider,
    );
  } catch (error) {
    console.warn("Rejected a webhook with a bad signature", error instanceof Error ? error.message : error);
    return json({ error: "Bad signature." }, 400);
  }

  const db = adminDatabase();
  const { changes, needsReview } = changesForEvent(event);

  // Log the event once. A repeat of an event we've already handled is acknowledged and skipped.
  const { error: logError } = await db
    .from("stripe_events")
    .insert({ id: event.id, type: event.type, account: event.account ?? null, needs_review: needsReview });
  if (logError) {
    if (logError.code === "23505") return json({ received: true, duplicate: true }, 200);
    console.error("Couldn't log webhook event", logError);
    return json({ error: "Try again." }, 500); // Stripe retries on errors
  }

  if (event.type === "account.updated") {
    try {
      await accountUpdated(db, event);
    } catch (failure) {
      console.error("Couldn't handle account update", event.id, failure);
      await db.from("stripe_events").delete().eq("id", event.id); // so Stripe's retry gets processed
      return json({ error: "Try again." }, 500);
    }
  }

  for (const change of changes) {
    let query = db.from("sponsors").update(change.set);
    query = change.by === "session" ? query.eq("stripe_checkout_session_id", change.id) : query.eq("stripe_subscription_id", change.id);
    if (change.onlyIfPending) query = query.eq("status", "pending");
    const { error } = await query;
    if (error) {
      console.error("Couldn't update sponsor for event", event.id, error);
      await db.from("stripe_events").delete().eq("id", event.id); // so Stripe's retry gets processed
      return json({ error: "Try again." }, 500);
    }
  }
  return json({ received: true }, 200);
});
