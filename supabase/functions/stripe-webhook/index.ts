// stripe-webhook - Stripe calls this when something happens to a payment on a nonprofit's account:
// a gift went through, a card failed, a sponsor canceled, a refund or dispute.
// Every message's signature is checked with the webhook secret before anything is trusted.
// Each event is logged once (Stripe can resend), then sponsor statuses are updated.

import Stripe from "npm:stripe@23";
import { adminDatabase, json, requireSetting, stripeClient } from "../_shared/clients.ts";
import { changesForEvent } from "../_shared/sponsorship.js";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (request) => {
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
