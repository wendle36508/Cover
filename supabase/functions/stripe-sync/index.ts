// stripe-sync - the nightly re-sync (approved Nov 18). Stripe retries webhooks for about 3 days; if
// Cover still missed one, this catches it. Every night at 7:30 UTC the database calls this function
// (with the shared CRON_SECRET). For every sponsorship that's pending, active or card-failed, it asks
// Stripe for the real status (practice pages marked is_test are skipped). Stripe wins: anything that didn't match is fixed and flagged in Cover HQ.
//
// GET ?health returns {ok:true} for the uptime monitor (no secret needed, nothing private).

import { adminDatabase, json, stripeClient } from "../_shared/clients.ts";
import { syncAction } from "../_shared/sponsorship.js";

const OPEN_STATUSES = ["pending", "active", "past_due"];

type Sponsor = {
  id: string;
  nonprofit_id: string;
  status: string;
  created_at: string;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
};

function isMissing(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string };
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

/** What Stripe says about one sponsorship, in the shape syncAction expects (null = nothing to ask). */
async function askStripe(stripe: ReturnType<typeof stripeClient>, sponsor: Sponsor, account: string) {
  try {
    if (sponsor.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(sponsor.stripe_subscription_id, {}, { stripeAccount: account });
      return { subscriptionStatus: subscription.status };
    }
    if (sponsor.status === "pending" && sponsor.stripe_checkout_session_id) {
      const session = await stripe.checkout.sessions.retrieve(sponsor.stripe_checkout_session_id, {}, { stripeAccount: account });
      const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
      return { sessionStatus: session.status, paymentStatus: session.payment_status, subscriptionId: subscription };
    }
    return null;
  } catch (error) {
    if (isMissing(error)) return { missing: true };
    throw error;
  }
}

async function flag(db: ReturnType<typeof adminDatabase>, sponsor: Sponsor, kind: string, coverStatus: string, stripeStatus: string | null, detail: string | null) {
  const { data: open } = await db.from("stripe_sync_issues").select("id").eq("sponsor_id", sponsor.id).eq("kind", kind).is("resolved_at", null).limit(1);
  if (open?.length) return; // already flagged and not dealt with yet
  await db.from("stripe_sync_issues").insert({
    sponsor_id: sponsor.id, nonprofit_id: sponsor.nonprofit_id, kind, cover_status: coverStatus, stripe_status: stripeStatus,
    detail: detail?.slice(0, 300) ?? null,
  });
}

async function resync() {
  const db = adminDatabase();
  const stripe = stripeClient();
  const { data: run, error: runError } = await db.from("stripe_sync_runs").insert({}).select("id").single();
  if (runError) throw runError;

  const [{ data: sponsors, error: sponsorError }, { data: nonprofits, error: npError }] = await Promise.all([
    db.from("sponsors").select("id, nonprofit_id, status, created_at, stripe_subscription_id, stripe_checkout_session_id").in("status", OPEN_STATUSES),
    db.from("nonprofits").select("id, stripe_account_id, is_test"),
  ]);
  if (sponsorError) throw sponsorError;
  if (npError) throw npError;
  // Practice pages (is_test) use old Stripe test accounts the live key can't see, so they're skipped.
  const accounts = new Map((nonprofits ?? []).filter((n) => !n.is_test).map((n) => [n.id, n.stripe_account_id]));

  let checked = 0;
  let fixed = 0;
  let errors = 0;
  for (const sponsor of (sponsors ?? []) as Sponsor[]) {
    const account = accounts.get(sponsor.nonprofit_id);
    if (!account) continue;
    try {
      const stripeSays = await askStripe(stripe, sponsor, account);
      if (!stripeSays) continue;
      checked += 1;
      const action = syncAction(sponsor, stripeSays);
      if (!action) continue;
      if (action.set) {
        const { error } = await db.from("sponsors").update(action.set).eq("id", sponsor.id).eq("status", sponsor.status);
        if (error) throw error;
        fixed += 1;
      }
      if (action.kind) await flag(db, sponsor, action.kind, sponsor.status, action.stripeStatus, null);
    } catch (error) {
      errors += 1;
      console.error("stripe-sync: couldn't check sponsor", sponsor.id, error);
      await flag(db, sponsor, "stripe_error", sponsor.status, null, error instanceof Error ? error.message : String(error));
    }
  }

  await db.from("stripe_sync_runs").update({ finished_at: new Date().toISOString(), checked, fixed, errors }).eq("id", run.id);
  return { checked, fixed, errors };
}

Deno.serve(async (request) => {
  if (request.method === "GET") return json({ ok: true, service: "stripe-sync" }, 200);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (expected.length < 32 || request.headers.get("x-cron-secret") !== expected) return json({ error: "Not allowed." }, 403);
  try {
    return json(await resync(), 200);
  } catch (error) {
    console.error("stripe-sync failed", error);
    return json({ error: "The re-sync failed. See the function logs." }, 500);
  }
});
