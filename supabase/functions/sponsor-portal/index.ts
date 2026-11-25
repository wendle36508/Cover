// sponsor-portal - the server behind a sponsor's "My gifts" page (covergiving.com/gifts.html).
//
// Anyone (the page's sign-in form, with the bot check):
//   { action: "request_link", email, turnstileToken }
//     Emails a "My gifts" link to that address. Always answers the same way, so the form never reveals
//     who sponsors. Rate limited, and counts toward the daily email budget.
//
// With a signed "My gifts" token (from that email, or the "Manage my gift" link in Cover's emails):
//   { action: "overview", token }                      every gift for the token's email, with Stripe details, its
//                                                      photo certificate link and the updates sent about who it follows
//   { action: "card", token, sponsorId }               a Stripe link that opens straight on "update your card"
//   { action: "amount", token, sponsorId, amount }     new monthly amount in dollars, from the next charge on
//   { action: "follow", token, sponsorId, itemId }     follow someone else at the same nonprofit
//   { action: "updates" | "wall", token, sponsorId, on }   emails or the thank-you wall on/off
//   { action: "cancel", token, sponsorId }             no more charges from now on
//
// Signing in on a computer by opening the email on a phone (Nov 25, 2026):
//   request_link may carry { waitSecret } from the computer; the answer then has { wait, code }
//   { action: "wait_info", token, wait }               on the phone: the number to compare
//   { action: "approve_wait", token, wait }            on the phone: "yes, sign in my computer"
//   { action: "check_wait", wait, secret }             on the computer, every few seconds: a token once approved
//
// The token names an email address; every change checks the gift belongs to that address.
// This function is separate from checkout on purpose: nothing here can stop new gifts.

import { adminDatabase, json, requireSetting, stripeClient } from "../_shared/clients.ts";
import {
  certificateUrl, fromLine, makeToken, manageLinkEmail, manageLinkFits, manageUrl, makeManageToken, normalizeEmail, readManageToken, REPLY_TO, utcDayStart,
} from "../_shared/email.js";
import { checkNotABot, fingerprint } from "../_shared/guards.ts";
import { cleanWaitId, cleanWaitSecret, linkWithWait, newWaitCode, sameText, sha256Hex, waitState } from "../_shared/link-wait.js";
import {
  amountChange, BadInput, canChange, cardSession, chargeForGift, giftView, PAYMENTS_SHOWN, portalConfiguration, readAmountCents, visibleSponsorships,
} from "../_shared/portal.js";
import { BadRequest, clientIp, corsHeaders, monthlyEquivalent, parseList, rateLimitMessage } from "../_shared/sponsorship.js";

class Problem extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPONSOR_COLUMNS = "id, nonprofit_id, item_id, email, status, monthly_cents, amount_cents, interval, fee_percent, covers_fee, updates_off, show_name, created_at, stripe_customer_id, stripe_subscription_id";
const UPDATES_SHOWN = 12; // per gift, newest first
const LINK_SENT = { sent: true, message: "If that email gives through Cover, a link is on its way. It can take a minute." };

type Sponsor = {
  id: string; nonprofit_id: string; item_id: string | null; email: string; status: string; monthly_cents: number; fee_percent: number; covers_fee: boolean;
  first_name?: string; last_initial?: string | null; business_name?: string | null; gift_name?: string | null;
  amount_cents: number | null; interval: string;
  updates_off: boolean; show_name: boolean; created_at: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
};

function readId(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Problem(`Missing or invalid ${what}.`);
  return value;
}

function giftsPage(): string {
  return `${requireSetting("SITE_URL").replace(/\/$/, "")}/gifts.html`;
}

/** The email address a "My gifts" token is for. */
async function emailFromToken(token: unknown): Promise<string> {
  const link = await readManageToken(requireSetting("EMAIL_LINK_SECRET"), token);
  if (!link) throw new Problem("This link has expired or isn't valid. Enter your email below and we'll send a fresh one.", 403);
  return link.email;
}

/** One gift, only if it belongs to the token's email address. */
async function ownGift(token: unknown, sponsorId: unknown): Promise<Sponsor> {
  const email = await emailFromToken(token);
  const { data, error } = await adminDatabase().from("sponsors").select(SPONSOR_COLUMNS).eq("id", readId(sponsorId, "gift")).maybeSingle();
  if (error) throw error;
  if (!data || normalizeEmail(data.email) !== email) throw new Problem("We couldn't find that gift.", 404);
  return data as Sponsor;
}

async function stripeAccountOf(nonprofitId: string): Promise<{ account: string; portalConfig: string | null }> {
  const { data, error } = await adminDatabase().from("nonprofits").select("stripe_account_id, stripe_portal_config").eq("id", nonprofitId).single();
  if (error) throw error;
  if (!data.stripe_account_id) throw new Problem("This nonprofit isn't set up for payments yet.");
  return { account: data.stripe_account_id, portalConfig: data.stripe_portal_config };
}

function needsChangeable(sponsor: Sponsor) {
  if (!canChange(sponsor.status)) throw new Problem("This gift has ended, so there's nothing to change.");
  if (!sponsor.stripe_subscription_id) throw new Problem("This gift isn't finished setting up yet. Try again in a few minutes.");
}

/** Every gift for one email address (newest first), straight from the database. */
async function giftsFor(email: string): Promise<Sponsor[]> {
  const { data, error } = await adminDatabase().rpc("gifts_for_email", { target: email });
  if (error) throw error;
  return (data ?? []) as Sponsor[];
}

// ---------- "Email me a link" ----------

async function sponsorEmailsSentToday(): Promise<number> {
  const { count, error } = await adminDatabase().from("sponsor_emails")
    .select("id", { count: "exact", head: true }).eq("status", "sent").gte("created_at", utcDayStart().toISOString());
  if (error) throw error;
  return count ?? 0;
}

async function requestLink(request: Request, body: Record<string, unknown>) {
  const email = normalizeEmail(body.email);
  if (!email) throw new Problem("That email doesn't look right.");
  const ip = clientIp(request.headers);
  await checkNotABot(body, ip);
  const db = adminDatabase();
  const { data: verdict, error: rateError } = await db.rpc("manage_link_rate_check", {
    ip_hash: await fingerprint(`link-ip:${ip || "unknown"}`),
    email_hash: await fingerprint(`link-email:${email}`),
  });
  if (rateError) throw rateError;
  const tooMany = rateLimitMessage(verdict);
  if (tooMany) throw new Problem(tooMany, 429);

  // A computer that wants to sign itself in once the link is opened on another device (phone).
  // Made either way, so the answer never shows whether this email gives through Cover.
  const waitSecret = cleanWaitSecret(body.waitSecret);
  let wait: { id: string; code: string } | null = null;
  if (waitSecret) {
    await db.from("sign_in_waits").delete().lt("created_at", new Date(Date.now() - 86400000).toISOString()); // old ones
    const { data: made, error: waitError } = await db.from("sign_in_waits")
      .insert({ email, secret_hash: await sha256Hex(waitSecret), code: newWaitCode() }).select("id, code").single();
    if (waitError) throw waitError;
    wait = made;
  }
  const answer = wait ? { ...LINK_SENT, wait: wait.id, code: wait.code } : LINK_SENT;

  if (!visibleSponsorships(await giftsFor(email)).length) return answer; // nobody to email; same answer either way

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Problem("Emails are off right now. Write to hello@covergiving.com and we'll help.", 503);
  if (!manageLinkFits(await sponsorEmailsSentToday())) {
    throw new Problem("We've sent a lot of emails today. Please try again tomorrow, or write to hello@covergiving.com.", 503);
  }
  const message = manageLinkEmail(linkWithWait(manageUrl(await makeManageToken(requireSetting("EMAIL_LINK_SECRET"), email)), wait?.id ?? null));
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromLine("Cover"), to: [email], reply_to: REPLY_TO, ...message }),
  });
  const sent = await response.json().catch(() => ({}));
  const { error: logError } = await db.from("sponsor_emails").insert({
    nonprofit_id: null, sponsor_id: null, item_id: null, kind: "manage_link",
    status: response.ok ? "sent" : "failed", provider_id: sent?.id ?? null,
  });
  if (logError) console.error("Couldn't log the My gifts email", logError.message);
  if (!response.ok) {
    console.error("Resend refused the My gifts email", response.status, sent?.message ?? sent?.name);
    throw new Problem("We couldn't send the email just now. Please try again in a minute.", 502);
  }
  return answer;
}

// ---------- Sign in on the computer from the phone ----------

type Wait = { id: string; email: string; secret_hash: string; code: string; created_at: string; approved_at: string | null; used_at: string | null };

async function findWait(value: unknown): Promise<Wait | null> {
  const id = cleanWaitId(value);
  if (!id) return null;
  const { data, error } = await adminDatabase().from("sign_in_waits").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Wait | null;
}

/** On the phone: a waiting sign-in for this link's email, still open. */
async function ownWait(body: Record<string, unknown>): Promise<Wait> {
  const email = await emailFromToken(body.token);
  const wait = await findWait(body.wait);
  if (!wait || normalizeEmail(wait.email) !== email || waitState(wait) !== "waiting") {
    throw new Problem("That computer sign-in has expired. Ask for a new link on the computer.", 404);
  }
  return wait;
}

async function waitInfo(body: Record<string, unknown>) {
  const wait = await ownWait(body);
  return { code: wait.code, requestedAt: wait.created_at };
}

async function approveWait(body: Record<string, unknown>) {
  const wait = await ownWait(body);
  const { error } = await adminDatabase().from("sign_in_waits").update({ approved_at: new Date().toISOString() }).eq("id", wait.id).is("approved_at", null);
  if (error) throw error;
  return { approved: true };
}

/** On the computer: with its secret, a My sponsorships token once the phone said yes (handed out once). */
async function checkWait(body: Record<string, unknown>) {
  const secret = cleanWaitSecret(body.secret);
  const wait = await findWait(body.wait);
  if (!secret || !wait || !sameText(await sha256Hex(secret), wait.secret_hash)) return { status: "expired" };
  const state = waitState(wait);
  if (state !== "approved") return { status: state === "waiting" ? "waiting" : "expired" };
  const { data: claimed, error } = await adminDatabase().from("sign_in_waits").update({ used_at: new Date().toISOString() })
    .eq("id", wait.id).is("used_at", null).select("id");
  if (error) throw error;
  if (!claimed?.length) return { status: "expired" }; // another check already picked it up
  return { status: "signed_in", token: await makeManageToken(requireSetting("EMAIL_LINK_SECRET"), wait.email) };
}

// ---------- The page ----------

/** Stripe's view of one gift (subscription with card, and recent payments). Null if Stripe can't be reached. */
async function stripeDetails(sponsor: Sponsor, account: string | null) {
  if (!account || !sponsor.stripe_subscription_id) return null;
  try {
    const stripe = stripeClient();
    const [subscription, invoices] = await Promise.all([
      stripe.subscriptions.retrieve(sponsor.stripe_subscription_id, { expand: ["default_payment_method"] }, { stripeAccount: account }),
      stripe.invoices.list({ subscription: sponsor.stripe_subscription_id, limit: PAYMENTS_SHOWN }, { stripeAccount: account }),
    ]);
    return { subscription, invoices: invoices.data };
  } catch (error) {
    console.error("Couldn't load Stripe details for a gift", sponsor.id, error instanceof Error ? error.message : error);
    return null;
  }
}

async function overview(body: Record<string, unknown>) {
  const email = await emailFromToken(body.token);
  const db = adminDatabase();
  const sponsors = visibleSponsorships(await giftsFor(email)) as Sponsor[];
  if (!sponsors.length) return { email, firstName: null, gifts: [] };

  const nonprofitIds = [...new Set(sponsors.map((s) => s.nonprofit_id))];
  const [{ data: nonprofits, error: npError }, { data: items, error: itemError }] = await Promise.all([
    db.from("nonprofits").select("id, name, slug, kind, page, stripe_account_id").in("id", nonprofitIds),
    db.from("follow_items").select("id, nonprofit_id, name, photo_url, photo_focus_x, photo_focus_y, status, sort_order, created_at").in("nonprofit_id", nonprofitIds)
      .order("sort_order").order("created_at"),
  ]);
  if (npError) throw npError;
  if (itemError) throw itemError;
  // The updates sent about who each gift follows (the page's updates feed).
  const followed = [...new Set(sponsors.map((s) => s.item_id).filter(Boolean))] as string[];
  const { data: updates, error: updateError } = followed.length
    ? await db.from("item_updates").select("item_id, body, photo_url, sent_at").in("item_id", followed).eq("status", "sent")
      .order("sent_at", { ascending: false }).limit(100)
    : { data: [], error: null };
  if (updateError) throw updateError;
  const secret = requireSetting("EMAIL_LINK_SECRET");
  const byNonprofit = new Map((nonprofits ?? []).map((np) => [np.id, np]));
  const byItem = new Map((items ?? []).map((item) => [item.id, item]));

  const gifts = await Promise.all(sponsors.map(async (sponsor) => {
    const nonprofit = byNonprofit.get(sponsor.nonprofit_id);
    return giftView({
      sponsor,
      nonprofit,
      item: sponsor.item_id ? byItem.get(sponsor.item_id) ?? null : null,
      choices: (items ?? []).filter((item) => item.nonprofit_id === sponsor.nonprofit_id && item.status === "active"),
      stripe: await stripeDetails(sponsor, nonprofit?.stripe_account_id ?? null),
      certificateUrl: sponsor.status === "pending" ? null : certificateUrl(await makeToken(secret, sponsor.id, "cert")),
      updates: (updates ?? []).filter((u) => u.item_id === sponsor.item_id && new Date(u.sent_at) >= new Date(sponsor.created_at)).slice(0, UPDATES_SHOWN),
    });
  }));
  return { email, firstName: sponsors[0].first_name ?? null, gifts };
}

// ---------- Changes ----------

/** Stripe's card-update screen settings on this nonprofit's account: made the first time, then reused. */
async function portalConfigFor(nonprofitId: string, account: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const created = await stripeClient().billingPortal.configurations.create(
    portalConfiguration(requireSetting("SITE_URL").replace(/\/$/, "")),
    { stripeAccount: account, idempotencyKey: `cover-portal-config-${nonprofitId}` },
  );
  const { error } = await adminDatabase().from("nonprofits").update({ stripe_portal_config: created.id }).eq("id", nonprofitId);
  if (error) console.error("Couldn't save the card-update settings id", error.message); // still usable this time
  return created.id;
}

async function card(body: Record<string, unknown>) {
  const sponsor = await ownGift(body.token, body.sponsorId);
  needsChangeable(sponsor);
  if (!sponsor.stripe_customer_id) throw new Problem("This gift isn't finished setting up yet. Try again in a few minutes.");
  const { account, portalConfig } = await stripeAccountOf(sponsor.nonprofit_id);
  const configuration = await portalConfigFor(sponsor.nonprofit_id, account, portalConfig);
  const session = await stripeClient().billingPortal.sessions.create(
    cardSession(sponsor.stripe_customer_id, configuration, giftsPage()),
    { stripeAccount: account },
  );
  return { url: session.url };
}

async function amount(body: Record<string, unknown>) {
  const sponsor = await ownGift(body.token, body.sponsorId);
  needsChangeable(sponsor);
  const giftCents = readAmountCents(body.amount, sponsor.interval); // yearly gifts allow yearly amounts
  const cents = chargeForGift(giftCents, sponsor); // adds the fee cover if they chose it when they signed up
  const { account } = await stripeAccountOf(sponsor.nonprofit_id);
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(sponsor.stripe_subscription_id!, {}, { stripeAccount: account });
  await stripe.subscriptions.update(sponsor.stripe_subscription_id!, amountChange(subscription, cents), { stripeAccount: account });
  const { error } = await adminDatabase().from("sponsors")
    .update({ monthly_cents: monthlyEquivalent(cents, sponsor.interval), amount_cents: cents }).eq("id", sponsor.id);
  if (error) throw error;
  return { monthlyCents: cents, giftCents };
}

async function follow(body: Record<string, unknown>) {
  const sponsor = await ownGift(body.token, body.sponsorId);
  if (!canChange(sponsor.status)) throw new Problem("This gift has ended, so there's no one to follow.");
  const itemId = readId(body.itemId, "choice");
  const db = adminDatabase();
  const { data: item, error } = await db.from("follow_items").select("id, name, nonprofit_id, status").eq("id", itemId).maybeSingle();
  if (error) throw error;
  if (!item || item.nonprofit_id !== sponsor.nonprofit_id || item.status !== "active") throw new Problem("Pick someone who's still on the page.");
  const { error: updateError } = await db.from("sponsors").update({ item_id: item.id }).eq("id", sponsor.id);
  if (updateError) throw updateError;
  return { following: { id: item.id, name: item.name } };
}

async function toggle(body: Record<string, unknown>, column: "updates_off" | "show_name") {
  const sponsor = await ownGift(body.token, body.sponsorId);
  if (typeof body.on !== "boolean") throw new Problem("Missing on or off.");
  const value = column === "updates_off" ? !body.on : body.on;
  const { error } = await adminDatabase().from("sponsors").update({ [column]: value }).eq("id", sponsor.id);
  if (error) throw error;
  return { on: body.on };
}

async function cancel(body: Record<string, unknown>) {
  const sponsor = await ownGift(body.token, body.sponsorId);
  needsChangeable(sponsor);
  const { account } = await stripeAccountOf(sponsor.nonprofit_id);
  try {
    await stripeClient().subscriptions.cancel(sponsor.stripe_subscription_id!, {}, { stripeAccount: account });
  } catch (error) {
    // Already canceled at Stripe (for example, by the nonprofit): just bring Cover's record in line.
    if ((error as { code?: string })?.code !== "resource_missing" && !String((error as Error)?.message).includes("canceled")) throw error;
  }
  const { error } = await adminDatabase().from("sponsors").update({ status: "canceled" }).eq("id", sponsor.id);
  if (error) throw error;
  return { status: "canceled" };
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request.headers.get("Origin") ?? "", parseList(Deno.env.get("ALLOWED_ORIGINS")));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET") return json({ ok: true, service: "sponsor-portal" }, 200, cors); // uptime monitor
  if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "request_link": return json(await requestLink(request, body), 200, cors);
      case "overview": return json(await overview(body), 200, cors);
      case "card": return json(await card(body), 200, cors);
      case "amount": return json(await amount(body), 200, cors);
      case "follow": return json(await follow(body), 200, cors);
      case "updates": return json(await toggle(body, "updates_off"), 200, cors);
      case "wall": return json(await toggle(body, "show_name"), 200, cors);
      case "cancel": return json(await cancel(body), 200, cors);
      case "wait_info": return json(await waitInfo(body), 200, cors);
      case "approve_wait": return json(await approveWait(body), 200, cors);
      case "check_wait": return json(await checkWait(body), 200, cors);
      default: throw new Problem("Unknown action.");
    }
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status, cors);
    if (error instanceof BadInput || error instanceof BadRequest) return json({ error: error.message }, 400, cors);
    console.error("sponsor-portal failed", error);
    return json({ error: "Something went wrong on our end. Please try again in a minute." }, 500, cors);
  }
});
