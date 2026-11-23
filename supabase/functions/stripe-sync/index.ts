// stripe-sync - the nightly re-sync (approved Nov 18). Stripe retries webhooks for about 3 days; if
// Cover still missed one, this catches it. Every night at 7:30 UTC the database calls this function
// (with the shared CRON_SECRET). For every sponsorship that's pending, active or card-failed, it asks
// Stripe for the real status (practice pages marked is_test are skipped). Stripe wins: anything that didn't match is fixed and flagged in Cover HQ.
//
// GET ?health returns {ok:true} for the uptime monitor (no secret needed, nothing private).
// POST {"check": "stripe_key"} (with the secret) tests the Stripe key's permissions without changing
// anything in Stripe: each call is built to fail on purpose (made-up ids, an invalid field), so a
// "missing permission" answer is the only thing that counts as a problem.

import { adminDatabase, json, STRIPE_API_VERSION, stripeClient, stripeKey } from "../_shared/clients.ts";
import { keyCheckVerdict } from "../_shared/sponsorship.js";
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
      return { sessionStatus: session.status, paymentStatus: session.payment_status, subscriptionId: subscription, mode: session.mode };
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

/** One Stripe call for the key check; returns the verdict for it. */
async function probe(label: string, path: string, method: string, account: string | null, body?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${stripeKey()}`, "Stripe-Version": STRIPE_API_VERSION };
  if (account) headers["Stripe-Account"] = account;
  if (body) headers["Content-Type"] = path.startsWith("/v2/") ? "application/json" : "application/x-www-form-urlencoded";
  try {
    const response = await fetch(`https://api.stripe.com${path}`, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    return { label, ...keyCheckVerdict(response.status, payload) };
  } catch (error) {
    return { label, verdict: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Every kind of Stripe call Cover makes, tried with the current key. */
async function checkStripeKey() {
  const db = adminDatabase();
  const { data: real } = await db.from("nonprofits").select("stripe_account_id").not("stripe_account_id", "is", null).eq("is_test", false).limit(1);
  const account = real?.[0]?.stripe_account_id ?? null;
  const target = account ?? "acct_1CoverKeyCheck00000";
  // Which key is in use, by its last 4 characters (Stripe shows the same 4 on its API keys page).
  // Never the key itself. Stripe now gives limited keys the same sk_live_ start as full ones.
  const key = stripeKey();
  const keyKind = `${Deno.env.get("STRIPE_RESTRICTED_KEY") ? "STRIPE_RESTRICTED_KEY" : "STRIPE_SECRET_KEY"} ending ${key.slice(-4)}`;
  const results = await Promise.all([
    probe("Read accounts (v2)", "/v2/core/accounts?limit=1", "GET", null),
    probe("Create accounts (v2)", "/v2/core/accounts", "POST", null, JSON.stringify({ dashboard: "not_a_real_value" })),
    probe("Read an account (v1)", `/v1/accounts/${target}`, "GET", null),
    probe("Create account sessions", "/v1/account_sessions", "POST", null, `account=${target}&components[payments][enabled]=true`),
    probe("Create checkout sessions (on a nonprofit's account)", "/v1/checkout/sessions", "POST", target, "mode=subscription&line_items[0][quantity]=0"),
    probe("Read checkout sessions (on a nonprofit's account)", "/v1/checkout/sessions/cs_live_CoverKeyCheck", "GET", target),
    probe("Read subscriptions (on a nonprofit's account)", "/v1/subscriptions/sub_CoverKeyCheck", "GET", target),
  ]);
  const missing = results.filter((r) => r.verdict === "missing_permission" || r.verdict === "unknown");
  return { key: keyKind, testedOnRealAccount: Boolean(account), ok: missing.length === 0, missing: missing.map((r) => r.label), results };
}

Deno.serve(async (request) => {
  if (request.method === "GET") return json({ ok: true, service: "stripe-sync" }, 200);
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (expected.length < 32 || request.headers.get("x-cron-secret") !== expected) return json({ error: "Not allowed." }, 403);
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.check === "stripe_key") return json(await checkStripeKey(), 200);
    return json(await resync(), 200);
  } catch (error) {
    console.error("stripe-sync failed", error);
    return json({ error: "The re-sync failed. See the function logs." }, 500);
  }
});
