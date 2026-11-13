// create-sponsorship - called by the sponsor pop-up after the donor fills in the form.
// 1. Checks the sign-up again (never trust the browser).
// 2. Checks the nonprofit is live and can take payments, and the dog or program is active.
// 3. Saves a "pending" sponsor (it only turns "active" when Stripe confirms payment via stripe-webhook).
// 4. Creates Stripe's card form for a monthly gift on the nonprofit's own Stripe account.
// Returns { clientSecret, stripeAccount } so the pop-up can show the card form.

import { adminDatabase, json, requireSetting, stripeClient } from "../_shared/clients.ts";
import { BadRequest, checkReady, checkoutRequest, corsHeaders, parseList, readSignup } from "../_shared/sponsorship.js";

Deno.serve(async (request) => {
  const allowedOrigins = parseList(Deno.env.get("ALLOWED_ORIGINS"));
  const cors = corsHeaders(request.headers.get("Origin") ?? "", allowedOrigins);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BadRequest("Send the sign-up as JSON.");
    }
    const signup = readSignup(body);
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
    console.error("create-sponsorship failed", error);
    return json({ error: "Something went wrong on our end. Please try again in a minute." }, 500, cors);
  }
});
