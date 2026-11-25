// stripe-connect - used by a signed-in nonprofit's dashboard.
//   { action: "session" } -> makes sure the nonprofit has a Stripe account (creating one the first
//                            time), then returns a short-lived key for Stripe's embedded screens
//                            (sign-up, payments, payouts, account settings) inside Cover.
//   { action: "status" }  -> asks Stripe whether the nonprofit can take payments, and turns their
//                            public page on (or off) to match. Only this server code can do that.

import type Stripe from "npm:stripe@23";
import { adminDatabase, json, STRIPE_API_VERSION, stripeClient, stripeKey } from "../_shared/clients.ts";
import {
  accountRequest, accountRequestV1, cardPaymentsStatus, cardPaymentsStatusV1, connectionMessage, DASHBOARD_FALLBACK, DASHBOARD_FIRST_CHOICE,
  EMBEDDED_COMPONENTS, isMissingAccount, pickContactEmail, readAction, readNonprofitId, shouldTryFallback, shouldUseV1Fallback,
} from "../_shared/connect.js";
import { corsHeaders, parseList } from "../_shared/sponsorship.js";
import { incomeByMonth, incomeSince, MAX_CHARGES } from "../_shared/income.js";

class NotAllowed extends Error {}

async function stripeV2(path: string, init: { method: string; body?: unknown; idempotencyKey?: string }) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeKey()}`,
    "Stripe-Version": STRIPE_API_VERSION,
    "Content-Type": "application/json",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function createAccount(nonprofit: { id: string; name: string }, email: string): Promise<string> {
  for (const dashboard of [DASHBOARD_FIRST_CHOICE, DASHBOARD_FALLBACK]) {
    const result = await stripeV2("/v2/core/accounts", {
      method: "POST",
      body: accountRequest(nonprofit, email, dashboard),
      idempotencyKey: `cover-account-${nonprofit.id}-${dashboard}`,
    });
    if (result.ok) return result.body.id;
    if (shouldUseV1Fallback(result.body)) {
      // Stripe refuses the newer way for Cover ("must be activated") even though Cover's account is
      // fully active (Nov 24, 2026). Make the same account the older way instead.
      console.warn("Stripe refused the newer account API; creating the account the older way.");
      const account = await stripeClient().accounts.create(
        accountRequestV1(nonprofit, email) as Stripe.AccountCreateParams,
        { idempotencyKey: `cover-account-v1-${nonprofit.id}` },
      );
      return account.id;
    }
    if (dashboard === DASHBOARD_FALLBACK || !shouldTryFallback(result.body)) {
      // Which Stripe account the server's key belongs to (an account ID, not a secret), so a key from
      // the wrong account shows up in the logs right away.
      const me = await stripeV2("/v1/account", { method: "GET" });
      console.error("Stripe key belongs to", me.body?.id ?? "unknown", "live:", stripeKey().includes("_live_"), "charges_enabled:", me.body?.charges_enabled);
      throw new Error(`Stripe couldn't create the account: ${result.body?.error?.message ?? "unknown error"}`);
    }
    console.warn("Stripe refused the first-choice dashboard; trying the fallback.", result.body?.error?.code);
  }
  throw new Error("Stripe couldn't create the account.");
}

// True only when Stripe confirms the saved account doesn't exist for Cover's key (for example, it
// was made in test mode before Cover went live). The newer lookup can answer "permission denied"
// for those, so ask the older one, which plainly says "resource_missing". Any other answer keeps it.
let olderAccount: Stripe.Account | null = null; // set when only the older lookup could find the account

async function accountIsGone(accountId: string, found: { status: number; body: unknown }): Promise<boolean> {
  olderAccount = null;
  if (isMissingAccount(found.status, found.body)) return true;
  try {
    olderAccount = await stripeClient().accounts.retrieve(accountId);
    return false;
  } catch (error) {
    const stripeError = error as { code?: string; type?: string; message?: string };
    console.warn("Older account lookup also failed:", stripeError?.type, stripeError?.code, stripeError?.message);
    return isMissingAccount(0, { error: { code: stripeError?.code, message: stripeError?.message } });
  }
}

/** The nonprofit's owner's email for Stripe (see pickContactEmail), falling back to the person setting it up. */
async function contactEmail(db: ReturnType<typeof adminDatabase>, nonprofitId: string, userEmail: string): Promise<string> {
  const [{ data: owners }, { data: invites }] = await Promise.all([
    db.from("staff").select("user_id").eq("nonprofit_id", nonprofitId).eq("role", "owner"),
    db.from("staff_invites").select("email").eq("nonprofit_id", nonprofitId).eq("role", "owner"),
  ]);
  const ownerEmails = await Promise.all((owners ?? []).map(async (o) => (await db.auth.admin.getUserById(o.user_id)).data.user?.email ?? ""));
  return pickContactEmail({ ownerEmails, invitedOwnerEmails: (invites ?? []).map((i) => i.email), userEmail });
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request.headers.get("Origin") ?? "", parseList(Deno.env.get("ALLOWED_ORIGINS")));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  try {
    const body = await request.json().catch(() => ({}));
    const action = readAction(body);
    const wantedNonprofit = readNonprofitId(body);
    const db = adminDatabase();

    // Who is asking? Must be a signed-in person who runs a nonprofit.
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await db.auth.getUser(token);
    if (userError || !userData?.user) throw new NotAllowed("Sign in again.");
    const user = userData.user;
    // Which nonprofit: the one asked for (must be theirs), or their only one.
    let staffQuery = db.from("staff").select("nonprofit_id").eq("user_id", user.id);
    if (wantedNonprofit) staffQuery = staffQuery.eq("nonprofit_id", wantedNonprofit);
    const { data: staffRows, error: staffError } = await staffQuery.limit(2);
    if (staffError) throw staffError;
    if (!staffRows?.length) throw new NotAllowed("Create your nonprofit first.");
    if (staffRows.length > 1) throw new NotAllowed("Pick which nonprofit first.");
    const staff = staffRows[0];
    const { data: nonprofit, error: nonprofitError } = await db
      .from("nonprofits")
      .select("id, name, stripe_account_id, is_live")
      .eq("id", staff.nonprofit_id)
      .single();
    if (nonprofitError) throw nonprofitError;

    // Look up the saved account. If Stripe says it doesn't exist (made in test mode before Cover went
    // live, or deleted), forget it so a fresh one is made below.
    let accountId = nonprofit.stripe_account_id;
    let account = null;
    if (accountId) {
      const found = await stripeV2(`/v2/core/accounts/${accountId}?include=configuration.merchant`, { method: "GET" });
      if (found.ok) {
        account = found.body;
      } else if (await accountIsGone(accountId, found)) {
        console.warn("Saved Stripe account no longer exists; replacing it.", accountId);
        const { error } = await db.from("nonprofits").update({ stripe_account_id: null, is_live: false }).eq("id", nonprofit.id);
        if (error) throw error;
        accountId = null;
        nonprofit.is_live = false;
      } else if (!olderAccount) {
        throw new Error(`Stripe couldn't look up the account: ${found.body?.error?.message ?? "unknown error"}`);
      }
      // Otherwise it's an older-style account the newer lookup can't read yet: keep going with olderAccount.
    }
    if (!accountId) {
      if (action === "status") return json({ status: "not_started", live: false, message: connectionMessage("not_started") }, 200, cors);
      if (action === "income") return json(incomeByMonth([], new Date()), 200, cors); // no payouts yet: no income, nothing created
      accountId = await createAccount(nonprofit, await contactEmail(db, nonprofit.id, user.email ?? ""));
      const { error } = await db.from("nonprofits").update({ stripe_account_id: accountId }).eq("id", nonprofit.id);
      if (error) throw error;
    }

    // The dashboard's income chart: real payments on their Stripe account, by month. Read only.
    if (action === "income") {
      const charges: Stripe.Charge[] = [];
      for await (const charge of stripeClient().charges.list({ created: { gte: incomeSince() }, limit: 100 }, { stripeAccount: accountId })) {
        charges.push(charge);
        if (charges.length >= MAX_CHARGES) break;
      }
      return json({ ...incomeByMonth(charges, new Date()), complete: charges.length < MAX_CHARGES }, 200, cors);
    }

    if (action === "session") {
      const session = await stripeClient().accountSessions.create({ account: accountId, components: EMBEDDED_COMPONENTS });
      return json({ clientSecret: session.client_secret }, 200, cors);
    }

    const status = account ? cardPaymentsStatus(account) : olderAccount ? cardPaymentsStatusV1(olderAccount) : "not_started";
    const live = status === "active";
    if (live !== nonprofit.is_live) {
      const { error } = await db.from("nonprofits").update({ is_live: live }).eq("id", nonprofit.id);
      if (error) throw error;
    }
    return json({ status, live, message: connectionMessage(status) }, 200, cors);
  } catch (error) {
    if (error instanceof NotAllowed) return json({ error: error.message }, 401, cors);
    if (error instanceof Error && error.message === "Unknown action.") return json({ error: error.message }, 400, cors);
    console.error("stripe-connect failed", error);
    return json({ error: "Something went wrong setting up payouts. Please try again." }, 500, cors);
  }
});
