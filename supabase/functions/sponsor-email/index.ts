// sponsor-email - Cover's sponsor emails (approved plan, Nov 14).
//
// For a nonprofit's signed-in team:
//   { action: "finish", itemId, note }
//     "Mark adopted / Mark finished": marks it finished, sets its sponsors back to following the
//     whole nonprofit, and emails the ones with updates on, asking if they'd like to pick a new
//     buddy. (Tanner's call: never move sponsors to a new buddy automatically.)
//
// For sponsors, from the links in their emails (no account needed; the link's signed token says
// which sponsorship it is and what it may do):
//   { action: "lookup", token }      what the updates page shows
//   { action: "stop" | "resume", token }   turn this sponsorship's emails off or back on
//   { action: "move", token, itemId }      follow a new buddy at the same nonprofit
// Email apps' one-click unsubscribe also POSTs here with ?a=stop&t=TOKEN.
//
// Owner updates (photo + one line about a dog or program):
//   { action: "post", itemId, text, photoUrl }   (signed-in team) sends now, or schedules it for
//     the next free morning (max one update email per dog per day, Eastern time)
//   { action: "send_due" }   (the database's 15-minute job, with the x-cron-secret header)
//     sends every scheduled update whose time has come
//
// Money never moves: every gift goes to the nonprofit's general fund. Only the follow changes.

import { createClient } from "npm:@supabase/supabase-js@2";

import { adminDatabase, json, requireSetting } from "../_shared/clients.ts";
import { adoptionEmail, fromLine, linkUrl, makeToken, readToken, REPLY_TO, updateEmail } from "../_shared/email.js";
import { corsHeaders, parseList } from "../_shared/sponsorship.js";

class Problem extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYING = ["pending", "active", "past_due"];
const RESEND_BATCH = 100; // the most emails Resend takes in one request

function readId(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Problem(`Missing or invalid ${what}.`);
  return value;
}

type Outgoing = { sponsorId: string; to: string; subject: string; html: string; text: string; from: string; stopUrl: string };

/** Send through Resend. Returns one result per email (its id, or null if it failed). */
async function sendAll(emails: Outgoing[]): Promise<(string | null)[]> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return emails.map(() => null);
  const results: (string | null)[] = [];
  for (let start = 0; start < emails.length; start += RESEND_BATCH) {
    const chunk = emails.slice(start, start + RESEND_BATCH);
    const response = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk.map((email) => ({
        from: email.from,
        to: [email.to],
        reply_to: REPLY_TO,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: {
          "List-Unsubscribe": `<${oneClickUrl(email.stopUrl)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }))),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Resend refused the emails", response.status, body?.message ?? body?.name);
      results.push(...chunk.map(() => null));
    } else {
      const ids = Array.isArray(body?.data) ? body.data : [];
      results.push(...chunk.map((_, i) => ids[i]?.id ?? null));
    }
  }
  return results;
}

/** Email apps' one-click unsubscribe goes straight to this function (no page to load). */
function oneClickUrl(stopUrl: string): string {
  const token = new URL(stopUrl).searchParams.get("t") ?? "";
  return `${requireSetting("SUPABASE_URL")}/functions/v1/sponsor-email?a=stop&t=${encodeURIComponent(token)}`;
}

/** A database client acting as the signed-in person, so the database itself checks they run this nonprofit. */
function asSignedInUser(request: Request) {
  const jwt = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new Problem("Sign in again.", 401);
  return createClient(requireSetting("SUPABASE_URL"), requireSetting("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Turn the database's friendly refusals (not allowed, bad input, gone) into a message for the owner. */
function friendly(error: { code?: string; message: string }): never {
  if (!["P0002", "42501", "22023"].includes(error.code ?? "")) throw error;
  throw new Problem(error.message, error.code === "42501" ? 403 : 400);
}

async function logEmails(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const { error } = await adminDatabase().from("sponsor_emails").insert(rows);
  if (error) console.error("Couldn't log sponsor emails", error.message);
}

// ---------- "Mark adopted / Mark finished" (the nonprofit's team) ----------

async function finish(request: Request, body: Record<string, unknown>) {
  const itemId = readId(body.itemId, "item");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
  const { data: moved, error: moveError } = await asSignedInUser(request).rpc("finish_item", {
    target_item: itemId, next_item: null, finish_note: note || null,
  });
  if (moveError) friendly(moveError);

  const db = adminDatabase();
  const { data: item, error: itemError } = await db.from("follow_items").select("id, name, nonprofit_id").eq("id", itemId).single();
  if (itemError) throw itemError;
  const [{ data: nonprofit, error: npError }, { data: active, error: activeError }] = await Promise.all([
    db.from("nonprofits").select("id, name, kind").eq("id", item.nonprofit_id).single(),
    db.from("follow_items").select("id, name").eq("nonprofit_id", item.nonprofit_id).eq("status", "active"),
  ]);
  if (npError) throw npError;
  if (activeError) throw activeError;
  const canPick = (active?.length ?? 0) > 0;

  const sponsors = (moved ?? []) as { sponsor_id: string; first_name: string; email: string; updates_off: boolean }[];
  const toEmail = sponsors.filter((s) => !s.updates_off);
  const secret = requireSetting("EMAIL_LINK_SECRET");
  const outgoing: Outgoing[] = await Promise.all(toEmail.map(async (s) => {
    const stopUrl = linkUrl("stop", await makeToken(secret, s.sponsor_id, "stop"));
    const pickUrl = canPick ? linkUrl("pick", await makeToken(secret, s.sponsor_id, "pick")) : null;
    const email = adoptionEmail({
      nonprofitName: nonprofit.name, kind: nonprofit.kind, firstName: s.first_name, finishedName: item.name,
      ownerNote: note, pickUrl, stopUrl,
    });
    return { sponsorId: s.sponsor_id, to: s.email, from: fromLine(nonprofit.name), stopUrl, ...email };
  }));
  const ids = await sendAll(outgoing);
  const emailsOn = Boolean(Deno.env.get("RESEND_API_KEY"));

  const log = [
    ...sponsors.filter((s) => s.updates_off).map((s) => ({ sponsor_id: s.sponsor_id, status: "skipped", provider_id: null })),
    ...outgoing.map((email, i) => ({ sponsor_id: email.sponsorId, status: ids[i] ? "sent" : emailsOn ? "failed" : "skipped", provider_id: ids[i] })),
  ].map((row) => ({ ...row, nonprofit_id: nonprofit.id, item_id: itemId, kind: "adopted" }));
  await logEmails(log);

  return {
    moved: sponsors.length,
    emailed: ids.filter(Boolean).length,
    muted: sponsors.length - toEmail.length,
    failed: emailsOn ? ids.filter((id) => !id).length : 0,
    emailsOn,
  };
}

// ---------- Owner updates ----------

async function post(request: Request, body: Record<string, unknown>) {
  const itemId = readId(body.itemId, "item");
  const text = typeof body.text === "string" ? body.text : "";
  const photoUrl = typeof body.photoUrl === "string" && body.photoUrl ? body.photoUrl : null;
  const { data, error } = await asSignedInUser(request).rpc("post_update", {
    target_item: itemId, update_text: text, update_photo: photoUrl,
  });
  if (error) friendly(error);
  const saved = (data ?? [])[0] as { update_id: string; send_after: string; send_now: boolean };
  if (!saved.send_now) return { sent: false, scheduledFor: saved.send_after, emailed: 0 };
  const result = await sendUpdate(saved.update_id);
  return { sent: true, scheduledFor: null, ...result };
}

/** Send one queued update to its sponsors. Claims it first, so the morning job and a post never both send it. */
async function sendUpdate(updateId: string) {
  const db = adminDatabase();
  const { data: claimed, error: claimError } = await db.from("item_updates")
    .update({ status: "sending" }).eq("id", updateId).eq("status", "queued")
    .select("id, nonprofit_id, item_id, body, photo_url").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { emailed: 0, sponsors: 0, emailsOn: true }; // someone else already sent it

  const [{ data: item }, { data: nonprofit }, { data: sponsors, error: sponsorError }] = await Promise.all([
    db.from("follow_items").select("name").eq("id", claimed.item_id).single(),
    db.from("nonprofits").select("name, kind").eq("id", claimed.nonprofit_id).single(),
    db.from("sponsors").select("id, first_name, email").eq("item_id", claimed.item_id)
      .in("status", ["active", "past_due"]).eq("updates_off", false),
  ]);
  if (sponsorError) throw sponsorError;

  const secret = requireSetting("EMAIL_LINK_SECRET");
  const outgoing: Outgoing[] = await Promise.all((sponsors ?? []).map(async (s) => {
    const stopUrl = linkUrl("stop", await makeToken(secret, s.id, "stop"));
    const email = updateEmail({
      nonprofitName: nonprofit?.name ?? "", kind: nonprofit?.kind ?? "program", firstName: s.first_name,
      itemName: item?.name ?? "", body: claimed.body, photoUrl: claimed.photo_url, stopUrl,
    });
    return { sponsorId: s.id, to: s.email, from: fromLine(nonprofit?.name ?? ""), stopUrl, ...email };
  }));
  const ids = await sendAll(outgoing);
  const emailsOn = Boolean(Deno.env.get("RESEND_API_KEY"));
  const emailed = ids.filter(Boolean).length;
  const allFailed = outgoing.length > 0 && emailed === 0;

  await db.from("item_updates").update({
    status: allFailed ? "failed" : "sent", sent_at: new Date().toISOString(), emailed,
  }).eq("id", claimed.id);
  await logEmails(outgoing.map((email, i) => ({
    sponsor_id: email.sponsorId, nonprofit_id: claimed.nonprofit_id, item_id: claimed.item_id, kind: "update",
    status: ids[i] ? "sent" : emailsOn ? "failed" : "skipped", provider_id: ids[i],
  })));
  return { emailed, sponsors: outgoing.length, emailsOn };
}

/** The database's 15-minute job: send every scheduled update whose time has come. */
async function sendDue(request: Request) {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const given = request.headers.get("x-cron-secret") ?? "";
  if (expected.length < 32 || given !== expected) throw new Problem("Not allowed.", 403);
  const { data: due, error } = await adminDatabase().from("item_updates")
    .select("id").eq("status", "queued").lte("send_after", new Date().toISOString()).order("send_after").limit(50);
  if (error) throw error;
  let sent = 0;
  for (const row of due ?? []) {
    try {
      await sendUpdate(row.id);
      sent += 1;
    } catch (failure) {
      console.error("Couldn't send update", row.id, failure);
    }
  }
  return { sent };
}

// ---------- Links in sponsors' emails ----------

async function sponsorFromToken(token: unknown, purposes: string[]) {
  const link = await readToken(requireSetting("EMAIL_LINK_SECRET"), token, purposes);
  if (!link) throw new Problem("This link isn't valid anymore. Use the newest email, or reply to it for help.", 403);
  const db = adminDatabase();
  const { data: sponsor, error } = await db
    .from("sponsors")
    .select("id, first_name, nonprofit_id, item_id, status, updates_off")
    .eq("id", link.sponsorId)
    .maybeSingle();
  if (error) throw error;
  if (!sponsor) throw new Problem("We couldn't find that sponsorship.", 404);
  return { db, sponsor, purpose: link.purpose };
}

async function lookup(body: Record<string, unknown>) {
  const { db, sponsor, purpose } = await sponsorFromToken(body.token, ["stop", "pick"]);
  const [{ data: nonprofit }, { data: current }, { data: items }] = await Promise.all([
    db.from("nonprofits").select("name, slug, kind, page").eq("id", sponsor.nonprofit_id).single(),
    sponsor.item_id ? db.from("follow_items").select("id, name").eq("id", sponsor.item_id).maybeSingle() : Promise.resolve({ data: null }),
    purpose === "pick"
      ? db.from("follow_items").select("id, name, photo_url, photo_focus_x, photo_focus_y").eq("nonprofit_id", sponsor.nonprofit_id)
        .eq("status", "active").order("sort_order").order("created_at")
      : Promise.resolve({ data: [] }),
  ]);
  const page = (nonprofit?.page ?? {}) as Record<string, unknown>;
  return {
    firstName: sponsor.first_name,
    nonprofit: { name: nonprofit?.name ?? "", slug: nonprofit?.slug ?? "", kind: nonprofit?.kind ?? "program", brandColor: page.brandColor ?? null, logo: page.logo ?? null },
    current: current ?? null,
    updatesOff: sponsor.updates_off,
    canMove: PAYING.includes(sponsor.status),
    items: items ?? [],
  };
}

async function setUpdates(token: unknown, off: boolean) {
  const { db, sponsor } = await sponsorFromToken(token, ["stop", "pick"]);
  const { error } = await db.from("sponsors").update({ updates_off: off }).eq("id", sponsor.id);
  if (error) throw error;
  return { updatesOff: off };
}

async function move(body: Record<string, unknown>) {
  const itemId = readId(body.itemId, "buddy");
  const { db, sponsor } = await sponsorFromToken(body.token, ["pick"]);
  if (!PAYING.includes(sponsor.status)) throw new Problem("This sponsorship has ended, so there's no one to follow.");
  const { data: item, error } = await db.from("follow_items").select("id, name, nonprofit_id, status").eq("id", itemId).maybeSingle();
  if (error) throw error;
  if (!item || item.nonprofit_id !== sponsor.nonprofit_id || item.status !== "active") throw new Problem("Pick someone who's still on the page.");
  const { error: updateError } = await db.from("sponsors").update({ item_id: item.id }).eq("id", sponsor.id);
  if (updateError) throw updateError;
  return { current: { id: item.id, name: item.name } };
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request.headers.get("Origin") ?? "", parseList(Deno.env.get("ALLOWED_ORIGINS")));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  try {
    // One-click unsubscribe from an email app: POST ?a=stop&t=TOKEN (form body, no JSON).
    const url = new URL(request.url);
    if (url.searchParams.get("a") === "stop" && url.searchParams.get("t")) {
      await setUpdates(url.searchParams.get("t"), true);
      return new Response(null, { status: 200, headers: cors });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    switch (body.action) {
      case "finish": return json(await finish(request, body), 200, cors);
      case "post": return json(await post(request, body), 200, cors);
      case "send_due": return json(await sendDue(request), 200, cors);
      case "lookup": return json(await lookup(body), 200, cors);
      case "stop": return json(await setUpdates(body.token, true), 200, cors);
      case "resume": return json(await setUpdates(body.token, false), 200, cors);
      case "move": return json(await move(body), 200, cors);
      default: throw new Problem("Unknown action.");
    }
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status, cors);
    console.error("sponsor-email failed", error);
    return json({ error: "Something went wrong. Please try again." }, 500, cors);
  }
});
