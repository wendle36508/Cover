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
//   { action: "wall_off" | "wall_on", token }   take their name off the thank-you wall, or put it back
// Email apps' one-click unsubscribe also POSTs here with ?a=stop&t=TOKEN.
//
// Owner updates (photo + one line about a dog or program):
//   { action: "post", itemId, text, photoUrl }   (signed-in team) sends now, or schedules it for
//     the next free morning (max one update email per dog per day, Eastern time)
//   { action: "send_due" }   (the database's 15-minute job, with the x-cron-secret header)
//     sends every scheduled update whose time has come, plus welcome emails (with the photo
//     certificate) and gift emails whose day has come
//   { action: "reminders" }  (a daily job, same header) emails owners: a week before each update
//     month they picked in their settings; 5 days before each month ends (when they didn't pick months)
//     for the dogs with sponsors and no update yet that month; and when a new sponsor has had no first
//     photo after 5 days (the welcome pack promises one in the first week)
//
// The photo certificate page: { action: "certificate", token } (a "cert" link) returns what it shows.
//
// Gifts: until the gift email reaches the person it's for, nobody gets that sponsorship's updates.
// From then on, updates and adoption notes go to them, not the giver (the giver still manages billing).
//
// Money never moves: every gift goes to the nonprofit's general fund. Only the follow changes.

import { createClient } from "npm:@supabase/supabase-js@2";

import { adminDatabase, json, requireSetting } from "../_shared/clients.ts";
import { certificateView, cleanUpdateMonths, recipientFor, remindersDue } from "../_shared/after-signup.js";
import {
  adoptionEmail, certificateUrl, firstUpdateNudgeEmail, fitsEmailBudget, fromLine, giftEmail, giftSetEmail, linkUrl, makeManageToken, makeToken, manageUrl,
  monthlyReminderEmail, nextBudgetDay, readToken, reminderEmail, REPLY_TO, SITE_URL, SPONSOR_EMAIL_DAILY_BUDGET, updateEmail, utcDayStart, welcomeEmail,
} from "../_shared/email.js";
import { chosenGiftCents, FIRST_UPDATE_WINDOW_DAYS, monthlyReminderDue, needsFirstUpdate, pageBasics } from "../_shared/pack.js";
import { corsHeaders, parseList } from "../_shared/sponsorship.js";

class Problem extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYING = ["pending", "active", "past_due"];
const DAY_MS = 86400000;

/** Where a photo should be centered ("50% 38%"), from the owner's saved focus point. */
function focusOf(item: { photo_focus_x?: number | null; photo_focus_y?: number | null } | null | undefined): string {
  return `${item?.photo_focus_x ?? 50}% ${item?.photo_focus_y ?? 38}%`;
}

/** What the welcome letter quotes about a dog: the first paragraph of its story, or its short description. */
function aboutOf(item: { story?: string | null; note?: string | null } | null | undefined): string {
  const story = String(item?.story ?? "").split(/\n\s*\n/).map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean);
  return story || String(item?.note ?? "").trim();
}
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
        headers: email.stopUrl
          ? { "List-Unsubscribe": `<${oneClickUrl(email.stopUrl)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
          : undefined, // owner reminders have no unsubscribe link
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

/** Sponsor emails Cover has sent since midnight UTC (Resend's daily quota window). */
async function sentToday(): Promise<number> {
  const { count, error } = await adminDatabase().from("sponsor_emails")
    .select("id", { count: "exact", head: true }).eq("status", "sent").gte("created_at", utcDayStart().toISOString());
  if (error) throw error;
  return count ?? 0;
}

async function logEmails(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const { error } = await adminDatabase().from("sponsor_emails").insert(rows);
  if (error) console.error("Couldn't log sponsor emails", error.message);
}

/** The "Manage my gift" link for a sponsor's email address (null if the address can't make one). */
async function manageLinkFor(secret: string, email: string): Promise<string | null> {
  try {
    return manageUrl(await makeManageToken(secret, email));
  } catch {
    return null; // the email still goes out, with the old "reply to change or cancel" line
  }
}

/** Which of these sponsors currently show on the thank-you wall (so their emails get the "take my name off" link). */
async function onTheWall(sponsorIds: string[]): Promise<Set<string>> {
  if (!sponsorIds.length) return new Set();
  const { data, error } = await adminDatabase().from("sponsors").select("id").in("id", sponsorIds).eq("show_name", true);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
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
  const gifts = await giftDetails(sponsors.map((s) => s.sponsor_id));
  // Each note goes to whoever gets this sponsorship's emails: the sponsor, or the person it was given to.
  const toEmail = sponsors.filter((s) => !s.updates_off)
    .map((s) => ({ ...s, to: recipientFor({ ...s, ...gifts.get(s.sponsor_id) }) }))
    .filter((s) => s.to);
  const onWall = await onTheWall(toEmail.map((s) => s.sponsor_id));
  const secret = requireSetting("EMAIL_LINK_SECRET");
  const outgoing: Outgoing[] = await Promise.all(toEmail.map(async (s) => {
    const to = s.to!;
    const stopToken = await makeToken(secret, s.sponsor_id, "stop");
    const stopUrl = linkUrl("stop", stopToken);
    const pickUrl = canPick ? linkUrl("pick", await makeToken(secret, s.sponsor_id, "pick")) : null;
    const email = adoptionEmail({
      nonprofitName: nonprofit.name, kind: nonprofit.kind, firstName: to.firstName, finishedName: item.name,
      ownerNote: note, pickUrl, stopUrl, wallUrl: !to.giftFrom && onWall.has(s.sponsor_id) ? linkUrl("wall", stopToken) : null,
      manageUrl: to.giftFrom ? null : await manageLinkFor(secret, s.email), giftFrom: to.giftFrom,
    });
    return { sponsorId: s.sponsor_id, to: to.to, from: fromLine(nonprofit.name), stopUrl, ...email };
  }));
  const emailsOn = Boolean(Deno.env.get("RESEND_API_KEY"));
  // Over today's email budget? The notes are written now and wait for tomorrow morning.
  if (emailsOn && outgoing.length && !fitsEmailBudget(await sentToday(), outgoing.length)) {
    const sendAfter = nextBudgetDay().toISOString();
    const { error: queueError } = await db.from("queued_emails").insert(outgoing.map((email) => ({
      nonprofit_id: nonprofit.id, sponsor_id: email.sponsorId, item_id: itemId, kind: "adopted", to_email: email.to,
      from_line: email.from, subject: email.subject, html: email.html, text_body: email.text, stop_url: email.stopUrl,
      send_after: sendAfter,
    })));
    if (queueError) throw queueError;
    return { moved: sponsors.length, emailed: 0, queued: outgoing.length, sendAfter, muted: sponsors.length - toEmail.length, failed: 0, emailsOn };
  }
  const ids = await sendAll(outgoing);

  const emailedIds = new Set(toEmail.map((s) => s.sponsor_id));
  const log = [
    ...sponsors.filter((s) => !emailedIds.has(s.sponsor_id)).map((s) => ({ sponsor_id: s.sponsor_id, status: "skipped", provider_id: null })),
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

/** Gift details for these sponsors (who it's for, and whether their gift email has arrived yet). */
async function giftDetails(sponsorIds: string[]) {
  const found = new Map<string, { gift_name: string | null; gift_email: string | null; gift_sent_at: string | null }>();
  if (!sponsorIds.length) return found;
  const { data, error } = await adminDatabase().from("sponsors").select("id, gift_name, gift_email, gift_sent_at").in("id", sponsorIds);
  if (error) throw error;
  for (const row of data ?? []) found.set(row.id, row);
  return found;
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
  if (result.deferredTo) return { sent: false, deferred: true, scheduledFor: result.deferredTo, emailed: 0 };
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
    db.from("follow_items").select("name, photo_focus_x, photo_focus_y").eq("id", claimed.item_id).single(),
    db.from("nonprofits").select("name, kind, page").eq("id", claimed.nonprofit_id).single(),
    db.from("sponsors")
      .select("id, first_name, email, show_name, gift_name, gift_email, gift_sent_at, created_at, interval, amount_cents, monthly_cents, covers_fee, fee_percent")
      .eq("item_id", claimed.item_id).in("status", ["active", "past_due"]).eq("updates_off", false),
  ]);
  if (sponsorError) throw sponsorError;
  // A gift's updates wait until its gift email has arrived, then go to the person it's for.
  const readers = (sponsors ?? []).map((s) => ({ ...s, to: recipientFor(s) })).filter((s) => s.to);

  // Keep room for sign-in emails: if today's budget can't fit this update, hold it for tomorrow morning.
  if (!fitsEmailBudget(await sentToday(), readers.length)) {
    const deferredTo = nextBudgetDay().toISOString();
    const { error: holdError } = await db.from("item_updates").update({ status: "queued", send_after: deferredTo }).eq("id", claimed.id);
    if (holdError) throw holdError;
    return { emailed: 0, sponsors: readers.length, emailsOn: true, deferredTo };
  }

  const secret = requireSetting("EMAIL_LINK_SECRET");
  const basics = pageBasics(nonprofit?.page, nonprofit?.kind);
  const outgoing: Outgoing[] = await Promise.all(readers.map(async (s) => {
    const to = s.to!;
    const stopToken = await makeToken(secret, s.id, "stop");
    const stopUrl = linkUrl("stop", stopToken);
    const email = updateEmail({
      nonprofitName: nonprofit?.name ?? "", kind: nonprofit?.kind ?? "program", firstName: to.firstName,
      itemName: item?.name ?? "", body: claimed.body, photoUrl: claimed.photo_url, photoFocus: focusOf(item), stopUrl,
      wallUrl: !to.giftFrom && s.show_name ? linkUrl("wall", stopToken) : null,
      manageUrl: to.giftFrom ? null : await manageLinkFor(secret, s.email), giftFrom: to.giftFrom,
      // "2 months together" counts from the day a gift arrived for the person it's for.
      startedAt: to.giftFrom ? s.gift_sent_at : s.created_at, amountCents: chosenGiftCents(s), interval: s.interval,
      helps: basics.helps, one: basics.one,
    });
    return { sponsorId: s.id, to: to.to, from: fromLine(nonprofit?.name ?? ""), stopUrl, ...email };
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

/** Only the database's scheduled jobs may call send_due and reminders. */
function requireCron(request: Request) {
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const given = request.headers.get("x-cron-secret") ?? "";
  if (expected.length < 32 || given !== expected) throw new Problem("Not allowed.", 403);
}

/** The database's 15-minute job: scheduled updates, then welcome and gift emails, then waiting adoption notes. */
async function sendDue(request: Request) {
  requireCron(request);
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
  const welcomes = await sendAfterSignup("welcome");
  const gifts = await sendAfterSignup("gift");
  return { sent, welcomes, gifts, adoptionNotes: await sendQueuedNotes() };
}

type SignupRow = {
  id: string; nonprofit_id: string; item_id: string | null; first_name: string; email: string; interval: string | null;
  gift_name: string | null; gift_email: string | null; gift_message: string | null; gift_send_on: string | null;
};

/**
 * Welcome emails (with the certificate) to new sponsors, or gift emails to the people gifts are for.
 * Each sponsor is claimed first (the sent_at time is set), so two runs never send the same one twice.
 */
async function sendAfterSignup(kind: "welcome" | "gift"): Promise<number> {
  const db = adminDatabase();
  const { data: due, error } = await db.rpc(kind === "welcome" ? "welcome_emails_due" : "gift_emails_due", { max_rows: 40 });
  if (error) throw error;
  // Only as many as fit in what's left of today's email budget; the rest go in a later run.
  let rows = ((due ?? []) as SignupRow[]).slice(0, Math.max(0, SPONSOR_EMAIL_DAILY_BUDGET - await sentToday()));
  if (!rows.length) return 0;

  const column = kind === "welcome" ? "certificate_sent_at" : "gift_sent_at";
  const { data: claimed, error: claimError } = await db.from("sponsors").update({ [column]: new Date().toISOString() })
    .in("id", rows.map((r) => r.id)).is(column, null).select("id");
  if (claimError) throw claimError;
  const mine = new Set((claimed ?? []).map((r) => r.id));
  rows = rows.filter((r) => mine.has(r.id));
  if (!rows.length) return 0;

  const [{ data: nonprofits }, { data: items }, { data: extras }] = await Promise.all([
    db.from("nonprofits").select("id, name, kind, page").in("id", [...new Set(rows.map((r) => r.nonprofit_id))]),
    db.from("follow_items").select("id, name, photo_url, photo_focus_x, photo_focus_y, note, story, is_group")
      .in("id", rows.map((r) => r.item_id).filter(Boolean) as string[]),
    db.from("sponsors").select("id, last_initial, business_name, amount_cents, monthly_cents, covers_fee, fee_percent").in("id", rows.map((r) => r.id)),
  ]);
  const npById = new Map((nonprofits ?? []).map((n) => [n.id, n]));
  const itemById = new Map((items ?? []).map((i) => [i.id, i]));
  const extraById = new Map((extras ?? []).map((x) => [x.id, x]));
  const secret = requireSetting("EMAIL_LINK_SECRET");

  const outgoing: Outgoing[] = await Promise.all(rows.map(async (r) => {
    const np = npById.get(r.nonprofit_id) ?? { name: "", kind: "program", page: {} };
    const item = r.item_id ? itemById.get(r.item_id) ?? null : null;
    const extra = extraById.get(r.id);
    const itemName = item?.name || np.name;
    const holderName = extra?.business_name || (extra?.last_initial ? `${r.first_name} ${extra.last_initial}.` : r.first_name);
    const cert = certificateUrl(await makeToken(secret, r.id, "cert"));
    const stopUrl = linkUrl("stop", await makeToken(secret, r.id, "stop"));
    // The welcome job also covers gifts: their buyer gets "your gift is set" (the person it's for gets the
    // gift email on the chosen day, from the gift job).
    const email = kind === "welcome" && r.gift_name
      ? giftSetEmail({ nonprofitName: np.name, giverName: r.first_name, recipientName: r.gift_name, itemName, sendOn: r.gift_send_on,
        today: easternToday(), message: r.gift_message, certificateUrl: cert, manageUrl: await manageLinkFor(secret, r.email) })
      : kind === "welcome"
      ? welcomeEmail({ nonprofitName: np.name, kind: np.kind, firstName: r.first_name, itemName, interval: r.interval, certificateUrl: cert,
        manageUrl: await manageLinkFor(secret, r.email), isItem: Boolean(item), isGroup: item?.is_group === true, about: aboutOf(item),
        photoUrl: item?.photo_url ?? null, photoFocus: focusOf(item), amountCents: chosenGiftCents(extra), holderName, page: np.page })
      : giftEmail({ nonprofitName: np.name, kind: np.kind, recipientName: r.gift_name ?? "", giverName: r.first_name, itemName, interval: r.interval,
        message: r.gift_message, certificateUrl: cert, stopUrl, photoUrl: item?.photo_url ?? null, photoFocus: focusOf(item) });
    return { sponsorId: r.id, to: kind === "welcome" ? r.email : r.gift_email ?? "", from: fromLine(np.name), stopUrl, ...email };
  }));
  const ids = await sendAll(outgoing);
  const emailsOn = Boolean(Deno.env.get("RESEND_API_KEY"));
  await logEmails(rows.map((r, i) => ({
    sponsor_id: r.id, nonprofit_id: r.nonprofit_id, item_id: r.item_id, kind: kind === "welcome" && r.gift_name ? "gift_set" : kind,
    status: ids[i] ? "sent" : emailsOn ? "failed" : "skipped", provider_id: ids[i],
  })));
  return ids.filter(Boolean).length;
}

// ---------- Owner reminders before each scheduled update ----------

/** Today's date in Eastern time, "YYYY-MM-DD" (where Cover's pilots are). */
function easternToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The daily job: a week before each update month an owner picked, email them a reminder (once). */
async function reminders(request: Request) {
  requireCron(request);
  const db = adminDatabase();
  const today = easternToday();
  const monthly = monthlyReminderDue(today);
  const { data: nonprofits, error } = await db.from("nonprofits").select("id, name, follow_label, page").eq("is_test", false);
  if (error) throw error;
  let sent = 0;
  let monthlySent = 0;
  let firstUpdate = 0;
  for (const np of nonprofits ?? []) {
    const page = (np.page ?? {}) as Record<string, unknown>;
    for (const due of remindersDue(page.updateMonths, today)) {
      try {
        if (await remindOwners(np, due)) sent += 1;
      } catch (failure) {
        console.error("Couldn't send reminder", np.id, failure);
      }
    }
    // Nonprofits that picked their own update months get the reminder above instead of the monthly one.
    if (monthly && !cleanUpdateMonths(page.updateMonths).length) {
      try {
        if (await remindMonthly(np, monthly)) monthlySent += 1;
      } catch (failure) {
        console.error("Couldn't send the monthly reminder", np.id, failure);
      }
    }
    try {
      if (await nudgeFirstUpdates(np)) firstUpdate += 1;
    } catch (failure) {
      console.error("Couldn't send the first-update reminder", np.id, failure);
    }
  }
  return { sent, monthly: monthlySent, firstUpdate };
}

/** The addresses of a nonprofit's owners (or, if none is marked owner, its whole team). */
async function ownerEmails(nonprofitId: string): Promise<string[]> {
  const db = adminDatabase();
  const { data: staff, error } = await db.from("staff").select("user_id, role").eq("nonprofit_id", nonprofitId);
  if (error) throw error;
  const owners = (staff ?? []).filter((s) => s.role === "owner");
  const people = owners.length ? owners : staff ?? [];
  return (await Promise.all(people.map(async (s) => (await db.auth.admin.getUserById(s.user_id)).data.user?.email ?? null)))
    .filter((e): e is string => Boolean(e));
}

/** Email the owners one reminder (logged like the others). Returns whether it went out. */
async function sendOwnerEmail(nonprofitId: string, emails: string[], email: { subject: string; html: string; text: string }): Promise<boolean> {
  const ids = await sendAll(emails.map((to) => ({ sponsorId: "", to, from: fromLine("Cover"), stopUrl: "", ...email })));
  await logEmails(emails.map((_, i) => ({
    sponsor_id: null, nonprofit_id: nonprofitId, item_id: null, kind: "reminder", status: ids[i] ? "sent" : "failed", provider_id: ids[i],
  })));
  return ids.some(Boolean);
}

type Reader = { id: string; item_id: string; created_at: string; gift_email: string | null; gift_sent_at: string | null };

/** Sponsors who get this nonprofit's update emails right now (a gift counts once its gift email has arrived). */
async function readingSponsors(nonprofitId: string): Promise<Reader[]> {
  const { data, error } = await adminDatabase().from("sponsors").select("id, item_id, created_at, gift_email, gift_sent_at")
    .eq("nonprofit_id", nonprofitId).in("status", ["active", "past_due"]).eq("updates_off", false).not("item_id", "is", null);
  if (error) throw error;
  return ((data ?? []) as Reader[]).filter((s) => !s.gift_email || s.gift_sent_at);
}

/** 5 days before the month ends: remind owners about every dog with sponsors and no update yet this month (once a month). */
async function remindMonthly(np: { id: string; name: string }, due: { dueOn: string; label: string; monthStart: string }) {
  const db = adminDatabase();
  const itemIds = [...new Set((await readingSponsors(np.id)).map((s) => s.item_id))];
  if (!itemIds.length) return false;
  const { data: updates, error: updateError } = await db.from("item_updates").select("item_id, status")
    .in("item_id", itemIds).gte("created_at", `${due.monthStart}T00:00:00-05:00`);
  if (updateError) throw updateError;
  const done = new Set((updates ?? []).filter((u) => u.status !== "failed").map((u) => u.item_id));
  const waiting = itemIds.filter((id) => !done.has(id));
  if (!waiting.length) return false; // every dog with sponsors already had its update
  const { data: items, error: itemError } = await db.from("follow_items").select("id, name").in("id", waiting)
    .eq("status", "active").order("sort_order");
  if (itemError) throw itemError;
  if (!items?.length) return false;

  // Claim this month's reminder first: if it's already in the table, it was sent.
  const { data: claimed, error: claimError } = await db.from("update_reminders")
    .upsert({ nonprofit_id: np.id, due_on: due.dueOn }, { onConflict: "nonprofit_id,due_on", ignoreDuplicates: true }).select("nonprofit_id");
  if (claimError) throw claimError;
  if (!claimed?.length) return false;
  const emails = await ownerEmails(np.id);
  if (!emails.length) return false;
  if (!fitsEmailBudget(await sentToday(), emails.length)) {
    await db.from("update_reminders").delete().eq("nonprofit_id", np.id).eq("due_on", due.dueOn); // try again tomorrow
    return false;
  }
  return sendOwnerEmail(np.id, emails, monthlyReminderEmail({
    nonprofitName: np.name, monthLabel: due.label, names: items.map((i) => i.name), dashboardUrl: `${SITE_URL}/dashboard.html`,
  }));
}

/** A new sponsor with no first photo after 5 days: remind the owners (once per sponsor). */
async function nudgeFirstUpdates(np: { id: string; name: string }) {
  const db = adminDatabase();
  const since = new Date(Date.now() - (FIRST_UPDATE_WINDOW_DAYS + 1) * DAY_MS).toISOString();
  const recent = (await readingSponsors(np.id))
    // A gift's clock starts when it reached the person it's for.
    .map((s) => ({ id: s.id, item_id: s.item_id, created_at: (s.gift_email ? s.gift_sent_at : s.created_at) ?? s.created_at }))
    .filter((s) => s.created_at >= since);
  if (!recent.length) return false;
  const [{ data: updates, error: updateError }, { data: nudged, error: nudgedError }] = await Promise.all([
    db.from("item_updates").select("item_id, status, sent_at, created_at").in("item_id", [...new Set(recent.map((s) => s.item_id))]).gte("created_at", since),
    db.from("first_update_nudges").select("sponsor_id").in("sponsor_id", recent.map((s) => s.id)),
  ]);
  if (updateError) throw updateError;
  if (nudgedError) throw nudgedError;
  const waiting = needsFirstUpdate(recent, updates ?? [], new Set((nudged ?? []).map((n) => n.sponsor_id))) as typeof recent;
  if (!waiting.length) return false;

  // Claim them first, so two runs never remind twice about the same sponsor.
  const { data: claimed, error: claimError } = await db.from("first_update_nudges")
    .upsert(waiting.map((s) => ({ sponsor_id: s.id, nonprofit_id: np.id })), { onConflict: "sponsor_id", ignoreDuplicates: true }).select("sponsor_id");
  if (claimError) throw claimError;
  const mine = new Set((claimed ?? []).map((c) => c.sponsor_id));
  const itemIds = [...new Set(waiting.filter((s) => mine.has(s.id)).map((s) => s.item_id))];
  if (!itemIds.length) return false;
  const { data: items, error: itemError } = await db.from("follow_items").select("id, name").in("id", itemIds).eq("status", "active");
  if (itemError) throw itemError;
  const emails = await ownerEmails(np.id);
  if (!items?.length || !emails.length) return false;
  if (!fitsEmailBudget(await sentToday(), emails.length)) {
    await db.from("first_update_nudges").delete().in("sponsor_id", [...mine]); // try again tomorrow
    return false;
  }
  return sendOwnerEmail(np.id, emails, firstUpdateNudgeEmail({
    nonprofitName: np.name, names: items.map((i) => i.name), dashboardUrl: `${SITE_URL}/dashboard.html`,
  }));
}

async function remindOwners(np: { id: string; name: string; follow_label: string | null }, due: { dueOn: string; label: string }) {
  const db = adminDatabase();
  // Claim this reminder first: if it's already in the table, it was sent.
  const { data: claimed, error: claimError } = await db.from("update_reminders")
    .upsert({ nonprofit_id: np.id, due_on: due.dueOn }, { onConflict: "nonprofit_id,due_on", ignoreDuplicates: true }).select("nonprofit_id");
  if (claimError) throw claimError;
  if (!claimed?.length) return false;

  const [emails, { count }] = await Promise.all([
    ownerEmails(np.id),
    db.from("sponsors").select("id", { count: "exact", head: true }).eq("nonprofit_id", np.id).in("status", ["active", "past_due"]).eq("updates_off", false),
  ]);
  if (!emails.length || !count) return false; // no one to remind, or no sponsors to write to
  if (!fitsEmailBudget(await sentToday(), emails.length)) {
    await db.from("update_reminders").delete().eq("nonprofit_id", np.id).eq("due_on", due.dueOn); // try again tomorrow
    return false;
  }
  return sendOwnerEmail(np.id, emails, reminderEmail({
    nonprofitName: np.name, followLabel: np.follow_label || "Programs", dueLabel: due.label, dashboardUrl: `${SITE_URL}/dashboard.html`, sponsorCount: count,
  }));
}

// ---------- The photo certificate page ----------

async function certificate(body: Record<string, unknown>) {
  const link = await readToken(requireSetting("EMAIL_LINK_SECRET"), body.token, ["cert"]);
  if (!link) throw new Problem("This certificate link isn't valid. Open the link in your email again.", 403);
  const db = adminDatabase();
  const { data: sponsor, error } = await db.from("sponsors")
    .select("id, first_name, last_initial, business_name, gift_name, interval, created_at, nonprofit_id, item_id, status")
    .eq("id", link.sponsorId).maybeSingle();
  if (error) throw error;
  if (!sponsor || sponsor.status === "pending") throw new Problem("We couldn't find that certificate.", 404);
  const [{ data: nonprofit }, { data: item }] = await Promise.all([
    db.from("nonprofits").select("name, kind, page").eq("id", sponsor.nonprofit_id).single(),
    sponsor.item_id
      ? db.from("follow_items").select("name, photo_url, photo_focus_x, photo_focus_y").eq("id", sponsor.item_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return certificateView({ sponsor, nonprofit, item });
}

/** Adoption notes that waited for today's budget: send the ones that are due, if they fit. */
async function sendQueuedNotes(): Promise<number> {
  const db = adminDatabase();
  const { data: due, error } = await db.from("queued_emails").select("*").lte("send_after", new Date().toISOString())
    .order("send_after").limit(90);
  if (error) throw error;
  if (!due?.length || !fitsEmailBudget(await sentToday(), due.length)) return 0;
  const outgoing: Outgoing[] = due.map((row) => ({
    sponsorId: row.sponsor_id, to: row.to_email, from: row.from_line, subject: row.subject, html: row.html, text: row.text_body,
    stopUrl: row.stop_url,
  }));
  const ids = await sendAll(outgoing);
  await logEmails(due.map((row, i) => ({
    sponsor_id: row.sponsor_id, nonprofit_id: row.nonprofit_id, item_id: row.item_id, kind: row.kind,
    status: ids[i] ? "sent" : "failed", provider_id: ids[i],
  })));
  const { error: deleteError } = await db.from("queued_emails").delete().in("id", due.map((row) => row.id));
  if (deleteError) throw deleteError;
  return ids.filter(Boolean).length;
}

// ---------- Links in sponsors' emails ----------

async function sponsorFromToken(token: unknown, purposes: string[]) {
  const link = await readToken(requireSetting("EMAIL_LINK_SECRET"), token, purposes);
  if (!link) throw new Problem("This link isn't valid anymore. Use the newest email, or open covergiving.com/gifts.html to get a fresh link.", 403);
  const db = adminDatabase();
  const { data: sponsor, error } = await db
    .from("sponsors")
    .select("id, first_name, nonprofit_id, item_id, status, updates_off, show_name")
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
    onWall: sponsor.show_name,
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

/** The sponsor's own switch for the thank-you wall (from the link in their emails). */
async function setWall(token: unknown, show: boolean) {
  const { db, sponsor } = await sponsorFromToken(token, ["stop", "pick"]);
  const { error } = await db.from("sponsors").update({ show_name: show }).eq("id", sponsor.id);
  if (error) throw error;
  return { onWall: show };
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
      case "reminders": return json(await reminders(request), 200, cors);
      case "certificate": return json(await certificate(body), 200, cors);
      case "lookup": return json(await lookup(body), 200, cors);
      case "stop": return json(await setUpdates(body.token, true), 200, cors);
      case "resume": return json(await setUpdates(body.token, false), 200, cors);
      case "move": return json(await move(body), 200, cors);
      case "wall_off": return json(await setWall(body.token, false), 200, cors);
      case "wall_on": return json(await setWall(body.token, true), 200, cors);
      default: throw new Problem("Unknown action.");
    }
  } catch (error) {
    if (error instanceof Problem) return json({ error: error.message }, error.status, cors);
    console.error("sponsor-email failed", error);
    return json({ error: "Something went wrong. Please try again." }, 500, cors);
  }
});
