// create-sponsorship - called by the sponsor pop-up after the donor fills in the form.
// 1. Checks the sign-up again (never trust the browser), then the bot check (Cloudflare Turnstile,
//    once TURNSTILE_SECRET_KEY is set) and the rate limits (per IP and per email, in the database).
// 2. Checks the nonprofit is live and can take payments, and the dog or program is active.
// 3. Saves a "pending" sponsor (it only turns "active" when Stripe confirms payment via stripe-webhook).
// 4. Creates Stripe's card form for a monthly gift on the nonprofit's own Stripe account.
// Returns { clientSecret, stripeAccount } so the pop-up can show the card form.

import { adminDatabase, json, requireSetting, stripeClient } from "../_shared/clients.ts";
import {
  BadRequest, botCheckOutcome, checkReady, checkoutRequest, clientIp, corsHeaders, parseList, rateLimitMessage, readSignup, TURNSTILE_VERIFY_URL,
} from "../_shared/sponsorship.js";

class TooMany extends Error {}

/** A keyed fingerprint (HMAC-SHA256), so the rate-limit table never holds a real IP or email. */
async function fingerprint(text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(requireSetting("EMAIL_LINK_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare Turnstile. Off until TURNSTILE_SECRET_KEY is set in Supabase secrets. */
async function checkNotABot(body: unknown, ip: string): Promise<void> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return;
  const token = typeof (body as { turnstileToken?: unknown })?.turnstileToken === "string" ? (body as { turnstileToken: string }).turnstileToken : "";
  if (!token) throw new BadRequest("Please finish the quick robot check, then try again.");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  let response: Response | null = null;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
  } catch (error) {
    console.error("Bot check unreachable", error);
  }
  const result = response && response.status < 500 ? await response.json().catch(() => null) : null;
  const outcome = botCheckOutcome(Boolean(response), response?.status ?? 0, result);
  if (outcome === "allow") {
    // Cloudflare down: let the donor through (the rate limits still apply). A bot-check outage must never stop real gifts.
    console.error("Bot check unavailable; allowing this checkout", response?.status ?? "no answer");
    return;
  }
  if (outcome === "block") {
    // Cloudflare's reason, for the logs: "invalid-input-response" = bad token (a bot); "invalid-input-secret" = our key is wrong.
    console.warn("Bot check failed", result?.["error-codes"] ?? response?.status);
    throw new BadRequest("We couldn't confirm you're not a robot. Refresh the page and try again.");
  }
}

/** Per-IP and per-email limits on opening the card form (stops card testing and bots). */
async function checkRateLimit(ip: string, email: string): Promise<void> {
  const { data: verdict, error } = await adminDatabase().rpc("checkout_rate_check", {
    ip_hash: await fingerprint(`ip:${ip || "unknown"}`),
    email_hash: await fingerprint(`email:${email}`),
  });
  if (error) throw error;
  const message = rateLimitMessage(verdict);
  if (message) throw new TooMany(message);
}

Deno.serve(async (request) => {
  const allowedOrigins = parseList(Deno.env.get("ALLOWED_ORIGINS"));
  const cors = corsHeaders(request.headers.get("Origin") ?? "", allowedOrigins);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET") return json({ ok: true, service: "create-sponsorship" }, 200, cors); // uptime monitor
  if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BadRequest("Send the sign-up as JSON.");
    }
    const signup = readSignup(body);
    const ip = clientIp(request.headers);
    await checkNotABot(body, ip);
    await checkRateLimit(ip, signup.email);
    const db = adminDatabase();

    const { data: nonprofit, error: nonprofitError } = await db
      .from("nonprofits")
      .select("id, slug, name, is_live, stripe_account_id, monthly_price_cents")
      .eq("slug", signup.slug)
      .maybeSingle();
    if (nonprofitError) throw nonprofitError;
    const { data: item, error: itemError } = await db
      .from("follow_items")
      .select("id, nonprofit_id, name, status")
      .eq("id", signup.itemId)
      .maybeSingle();
    if (itemError) throw itemError;
    if (!nonprofit) throw new BadRequest("That nonprofit page doesn't exist.");
    if (!item) throw new BadRequest("That one can't be sponsored right now.");
    checkReady(nonprofit, item);

    const { data: sponsor, error: insertError } = await db
      .from("sponsors")
      .insert({
        nonprofit_id: nonprofit.id,
        item_id: item.id,
        first_name: signup.firstName,
        email: signup.email,
        show_name: signup.showName,
        last_initial: signup.lastInitial,
        business_name: signup.businessName,
        monthly_cents: nonprofit.monthly_price_cents,
        status: "pending",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const session = await stripeClient().checkout.sessions.create(
      checkoutRequest({ nonprofit, item, sponsorId: sponsor.id, signup, siteUrl: requireSetting("SITE_URL") }),
      { stripeAccount: nonprofit.stripe_account_id },
    );
    const { error: linkError } = await db.from("sponsors").update({ stripe_checkout_session_id: session.id }).eq("id", sponsor.id);
    if (linkError) throw linkError;

    return json({ clientSecret: session.client_secret, stripeAccount: nonprofit.stripe_account_id }, 200, cors);
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400, cors);
    if (error instanceof TooMany) return json({ error: error.message }, 429, cors);
    console.error("create-sponsorship failed", error);
    return json({ error: "Something went wrong on our end. Please try again in a minute." }, 500, cors);
  }
});
