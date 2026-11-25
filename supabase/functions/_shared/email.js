// email.js - sponsor emails: the secure links inside them and the wording (plain JavaScript,
// tested with Node, used by the sponsor-email server function).
//
// Links: every email carries links like covergiving.com/updates.html?a=stop&t=TOKEN. The token
// names one sponsorship and what the link may do, and is signed with a secret only Cover's server
// knows, so nobody can make a link for someone else's sponsorship.
//   * "stop" links (stop or restart updates) never expire, as people expect from unsubscribe links.
//   * "pick" links (choose a different buddy) last 30 days.
//   * "manage" links (the sponsor's "My gifts" page: card, amount, buddy, cancel) name an email address,
//     not one sponsorship, so one link shows every gift that email gives. They last 60 days; the page
//     can email a fresh one.

export const SITE_URL = "https://covergiving.com";
export const FROM_ADDRESS = "hello@covergiving.com";
export const REPLY_TO = "hello@covergiving.com"; // Tanner's call: replies (like cancel requests) come to Cover
export const PICK_LINK_DAYS = 30;
export const MANAGE_LINK_DAYS = 60;

// Resend's free plan sends 100 emails per UTC day, shared by sign-in links and sponsor emails
// (Tanner, Nov 18: stay on the free plan). Sponsor update emails stop at 70 a day so sign-ins
// always have about 30 left. An update that would go over waits for the next morning.
export const RESEND_DAILY_LIMIT = 100;
export const SPONSOR_EMAIL_DAILY_BUDGET = 70;
const BUDGET_RESEND_HOUR_UTC = 14; // 9am Eastern in winter, 10am in summer

/** Midnight UTC at the start of the day `now` is in (Resend's daily quota resets then). */
export function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** When a held-back update goes out: tomorrow (UTC) at 14:00 UTC. */
export function nextBudgetDay(now = new Date()) {
  const start = utcDayStart(now);
  return new Date(start.getTime() + 86400000 + BUDGET_RESEND_HOUR_UTC * 3600000);
}

/**
 * Can an update to `audience` sponsors go out now, given `sentToday` sponsor emails already sent?
 * Yes if it fits in today's budget. An update bigger than the whole budget goes out first thing on a
 * fresh day (nothing sent yet), so it's never stuck forever.
 */
export function fitsEmailBudget(sentToday, audience, budget = SPONSOR_EMAIL_DAILY_BUDGET) {
  const sent = Math.max(0, Number(sentToday) || 0);
  const size = Math.max(0, Number(audience) || 0);
  return size === 0 || sent + size <= budget || sent === 0;
}

// "Email me a link to my gifts" is a sign-in, so it may use the room kept for sign-ins, but stops at 90
// sponsor-side emails a day so nonprofit staff always have 10 sign-in links left.
export const MANAGE_LINK_DAILY_CAP = 90;

/** Can one more "My gifts" link go out today, given `sentToday` sponsor-side emails already sent? */
export function manageLinkFits(sentToday, cap = MANAGE_LINK_DAILY_CAP) {
  return Math.max(0, Number(sentToday) || 0) < cap;
}
const PURPOSES = new Set(["stop", "pick", "cert"]); // cert: the photo certificate (never expires)

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signature(secret, data) {
  if (!secret || secret.length < 32) throw new Error("The email link secret is missing or too short.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

/** Compare two strings without leaking where they differ through timing. */
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A signed token for one sponsorship and one purpose ("stop" or "pick"). */
export async function makeToken(secret, sponsorId, purpose, nowMs = Date.now()) {
  if (!PURPOSES.has(purpose)) throw new Error("Unknown link purpose.");
  const expires = purpose === "pick" ? Math.floor(nowMs / 1000) + PICK_LINK_DAYS * 86400 : 0;
  const body = base64url(encoder.encode(JSON.stringify({ s: sponsorId, p: purpose, x: expires })));
  return `${body}.${await signature(secret, body)}`;
}

/** The token's { sponsorId, purpose } if it's genuine, unexpired and for an allowed purpose; otherwise null. */
export async function readToken(secret, token, allowedPurposes, nowMs = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!sameText(parts[1], await signature(secret, parts[0]))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
  } catch {
    return null;
  }
  if (typeof payload?.s !== "string" || !PURPOSES.has(payload.p) || !allowedPurposes.includes(payload.p)) return null;
  if (payload.x && payload.x * 1000 < nowMs) return null;
  return { sponsorId: payload.s, purpose: payload.p };
}

/** The covergiving.com page a link opens. */
export function linkUrl(action, token) {
  return `${SITE_URL}/updates.html?a=${encodeURIComponent(action)}&t=${encodeURIComponent(token)}`;
}

/** An email address as Cover compares it: trimmed and lowercase. Empty string if it isn't an email. */
export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) ? email : "";
}

/** A signed "My gifts" token for every sponsorship this email address gives. Lasts MANAGE_LINK_DAYS. */
export async function makeManageToken(secret, email, nowMs = Date.now()) {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("A manage link needs a real email address.");
  const expires = Math.floor(nowMs / 1000) + MANAGE_LINK_DAYS * 86400;
  const body = base64url(encoder.encode(JSON.stringify({ e: clean, p: "manage", x: expires })));
  return `${body}.${await signature(secret, body)}`;
}

/** The email address a genuine, unexpired "My gifts" token is for; otherwise null. */
export async function readManageToken(secret, token, nowMs = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!sameText(parts[1], await signature(secret, parts[0]))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
  } catch {
    return null;
  }
  if (payload?.p !== "manage" || !normalizeEmail(payload.e) || !payload.x || payload.x * 1000 < nowMs) return null;
  return { email: payload.e };
}

/** The "My gifts" page for a manage token. */
export function manageUrl(token) {
  return `${SITE_URL}/gifts.html?t=${encodeURIComponent(token)}`;
}

const MANAGE_LINK_TEXT = "Manage my gift";
const REPLY_FOOTER = "To change or cancel your monthly gift, just reply to this email.";

/**
 * The footer's first line: a "Manage my gift" link (card, amount, cancel), or the old reply line if there's
 * no link. For someone who was GIVEN the sponsorship, it says who it's from instead (the giver manages it).
 */
function manageFooter(url, giftFrom = null) {
  if (giftFrom) {
    const line = `This sponsorship is a gift from ${giftFrom}.`;
    return { text: line, html: escapeHtml(line) };
  }
  if (!url) return { text: REPLY_FOOTER, html: escapeHtml(REPLY_FOOTER) };
  return {
    text: `${MANAGE_LINK_TEXT} (card, amount or cancel): ${url}`,
    html: `<a href="${escapeHtml(url)}" style="color:#0B6B47;font-weight:700">${MANAGE_LINK_TEXT}</a> (card, amount or cancel)`,
  };
}

/**
 * The email with a sponsor's "My gifts" link, sent when they ask for one on the page.
 * Says the same thing whether or not they have gifts, so the page never reveals who sponsors.
 */
export function manageLinkEmail(url) {
  const subject = "Your link to manage your gifts";
  const text = [
    "Hi,",
    "",
    "Here's your link to see and manage your monthly gifts on Cover: update your card, change the amount, switch who you follow, or cancel.",
    "",
    url,
    "",
    `The link works for ${MANAGE_LINK_DAYS} days. If you didn't ask for it, you can ignore this email.`,
    "Cover",
  ].join("\n");
  const e = escapeHtml;
  const html = `<div style="background:#F5F7F6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E9EC;border-radius:16px;padding:32px">
    <p style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0B6B47;margin:0 0 12px">Cover</p>
    <h1 style="font-size:26px;line-height:1.2;color:#14181C;margin:0 0 18px">Manage your gifts</h1>
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 18px">Update your card, change the amount, switch who you follow, or cancel.</p>
    <a href="${e(url)}" style="display:inline-block;background:#22C67A;color:#14181C;font-weight:700;font-size:15px;text-decoration:none;padding:12px 20px;border-radius:10px">Open my gifts</a>
    <p style="font-size:13px;line-height:1.55;color:#6B747C;margin:24px 0 0">The link works for ${MANAGE_LINK_DAYS} days. If you didn't ask for it, you can ignore this email.</p>
  </div>
</div>`;
  return { subject, text, html };
}

const WALL_LINK_TEXT = "Take my name off the thank-you wall";

/** The extra footer line for sponsors on the thank-you wall (text and HTML). Empty when there's no link. */
function wallLink(wallUrl) {
  if (!wallUrl) return { text: "", html: "" };
  return { text: `${WALL_LINK_TEXT}: ${wallUrl}`, html: ` · <a href="${escapeHtml(wallUrl)}" style="color:#6B747C">${WALL_LINK_TEXT}</a>` };
}

/** Make text safe to put inside an email's HTML. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** "Harbor Paws via Cover <hello@covergiving.com>", with characters that could break the header removed. */
export function fromLine(nonprofitName) {
  const clean = String(nonprofitName ?? "").replace(/[\r\n"<>\\,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Cover";
  return `${clean} via Cover <${FROM_ADDRESS}>`;
}

/**
 * The note sponsors get when what they follow is adopted (animals) or finished (programs).
 * details: { nonprofitName, kind, firstName, finishedName, ownerNote, pickUrl, stopUrl, wallUrl, manageUrl }
 * wallUrl (optional) is only given to sponsors whose name is on the thank-you wall.
 * Tanner's call (Nov 14): sponsors are never moved to a new buddy automatically. They go back to
 * following the whole nonprofit, and the email asks if they'd like to pick someone new.
 * pickUrl is null when there's no one else on the page to pick.
 */
export function adoptionEmail(details) {
  const { nonprofitName, kind, firstName, finishedName, ownerNote, pickUrl, stopUrl, wallUrl, manageUrl: manage, giftFrom } = details;
  const wall = wallLink(wallUrl);
  const footer = manageFooter(manage, giftFrom);
  const animal = kind === "animal";
  const subject = animal ? `${finishedName} went home!` : `${finishedName} has wrapped up`;
  const news = animal
    ? `Big news from ${nonprofitName}: ${finishedName} was adopted and went home.`
    : `${finishedName} at ${nonprofitName} has wrapped up. Thank you for being part of it.`;
  const whole = animal ? "rescue" : "nonprofit";
  const gift = `Your monthly gift keeps helping ${animal ? "every animal" : "everything"} at ${nonprofitName}, just like before.`;
  const ask = pickUrl
    ? `Would you like to follow ${animal ? "a new buddy" : "something new"}? Pick one and you'll get their updates. If not, no problem: we'll keep you posted with news from the whole ${whole}.`
    : `There's no one else on their page right now, so we'll keep you posted with news from the whole ${whole}.`;
  const button = animal ? "Pick a new buddy" : "Pick what to follow";

  const text = [
    `Hi ${firstName},`,
    "",
    news,
    ownerNote ? `\n"${ownerNote}" (${nonprofitName})\n` : "",
    gift,
    "",
    ask,
    pickUrl ? `${button}: ${pickUrl}\n` : "",
    `Thank you for being a sponsor.`,
    `${nonprofitName}, via Cover`,
    "",
    "---",
    footer.text,
    `Stop these updates: ${stopUrl}`,
    wall.text,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trimEnd();

  const e = escapeHtml;
  const html = `<div style="background:#F5F7F6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E9EC;border-radius:16px;padding:32px">
    <p style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0B6B47;margin:0 0 12px">${e(nonprofitName)}</p>
    <h1 style="font-size:26px;line-height:1.2;color:#14181C;margin:0 0 18px">${e(subject)}</h1>
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">Hi ${e(firstName)},</p>
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">${e(news)}</p>
    ${ownerNote ? `<p style="font-size:16px;line-height:1.55;color:#14181C;margin:0 0 14px;padding:12px 16px;background:#F5F7F6;border-radius:10px">"${e(ownerNote)}"</p>` : ""}
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">${e(gift)}</p>
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 18px">${e(ask)}</p>
    ${pickUrl ? `<a href="${e(pickUrl)}" style="display:inline-block;background:#22C67A;color:#14181C;font-weight:700;font-size:15px;text-decoration:none;padding:12px 20px;border-radius:10px">${e(button)}</a>` : ""}
    <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:24px 0 0">Thank you for being a sponsor.<br>${e(nonprofitName)}</p>
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6B747C;text-align:center">${footer.html}<br>
    <a href="${e(stopUrl)}" style="color:#6B747C">Stop these updates</a>${wall.html} · Sent by Cover for ${e(nonprofitName)}</p>
</div>`;

  return { subject, text, html };
}

/**
 * An owner's update about one dog or program, sent to its sponsors.
 * details: { nonprofitName, kind, firstName, itemName, body, photoUrl, stopUrl, wallUrl, manageUrl }
 * photoUrl is optional and must be an https address (checked by the database too).
 */
export function updateEmail(details) {
  const { nonprofitName, kind, firstName, itemName, body, photoUrl, stopUrl, wallUrl, manageUrl: manage, giftFrom } = details;
  const wall = wallLink(wallUrl);
  const footer = manageFooter(manage, giftFrom);
  const animal = kind === "animal";
  const subject = `News about ${itemName}`;
  const photo = /^https:\/\/[^\s"'<>]+$/.test(String(photoUrl ?? "")) ? photoUrl : "";
  const thanks = `Thanks for sponsoring ${itemName}. Your monthly gift helps ${animal ? "every animal" : "everything"} at ${nonprofitName}.`;

  const text = [
    `Hi ${firstName},`,
    "",
    `An update on ${itemName} from ${nonprofitName}:`,
    "",
    `"${body}"`,
    "",
    photo ? `Photo: ${photo}\n` : "",
    thanks,
    "",
    "---",
    footer.text,
    `Stop updates about ${itemName}: ${stopUrl}`,
    wall.text,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trimEnd();

  const e = escapeHtml;
  const html = `<div style="background:#F5F7F6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E9EC;border-radius:16px;overflow:hidden">
    ${photo ? `<img src="${e(photo)}" alt="${e(itemName)}" width="520" style="display:block;width:100%;height:auto;max-height:420px;object-fit:cover">` : ""}
    <div style="padding:28px 32px 32px">
      <p style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0B6B47;margin:0 0 12px">${e(nonprofitName)}</p>
      <h1 style="font-size:26px;line-height:1.2;color:#14181C;margin:0 0 18px">${e(subject)}</h1>
      <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">Hi ${e(firstName)},</p>
      <p style="font-size:18px;line-height:1.5;color:#14181C;margin:0 0 18px">${e(body)}</p>
      <p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0">${e(thanks)}<br>${e(nonprofitName)}</p>
    </div>
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6B747C;text-align:center">${footer.html}<br>
    <a href="${e(stopUrl)}" style="color:#6B747C">Stop updates about ${e(itemName)}</a>${wall.html} · Sent by Cover for ${e(nonprofitName)}</p>
</div>`;

  return { subject, text, html };
}

// ---------- After signing up (phase 4, Nov 23): certificate, gifts, owner reminders ----------

/** The photo certificate's address: covergiving.com/certificate.html?t=... (a signed, never-expiring link). */
export function certificateUrl(token) {
  return `${SITE_URL}/certificate.html?t=${encodeURIComponent(token)}`;
}

/** The shared card every after-signup email uses (same look as the other sponsor emails). */
function afterSignupHtml({ eyebrow, heading, greeting, lines, quote, buttonText, buttonUrl, closing, footer }) {
  const e = escapeHtml;
  const paras = lines.map((line) => `<p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">${e(line)}</p>`).join("\n    ");
  return `<div style="background:#F5F7F6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E9EC;border-radius:16px;padding:32px">
    <p style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0B6B47;margin:0 0 12px">${e(eyebrow)}</p>
    <h1 style="font-size:26px;line-height:1.2;color:#14181C;margin:0 0 18px">${e(heading)}</h1>
    ${greeting ? `<p style="font-size:16px;line-height:1.55;color:#4A525A;margin:0 0 14px">${e(greeting)}</p>` : ""}
    ${paras}
    ${quote ? `<p style="font-size:16px;line-height:1.55;color:#14181C;margin:0 0 14px;padding:12px 16px;background:#F5F7F6;border-radius:10px">"${e(quote)}"</p>` : ""}
    ${buttonUrl ? `<a href="${e(buttonUrl)}" style="display:inline-block;background:#22C67A;color:#14181C;font-weight:700;font-size:15px;text-decoration:none;padding:12px 20px;border-radius:10px">${e(buttonText)}</a>` : ""}
    ${closing ? `<p style="font-size:16px;line-height:1.55;color:#4A525A;margin:24px 0 0">${e(closing[0])}<br>${e(closing[1])}</p>` : ""}
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6B747C;text-align:center">${footer}</p>
</div>`;
}

/**
 * The welcome email right after someone starts sponsoring (or gives once), with their certificate.
 * details: { nonprofitName, kind, firstName, itemName, interval, certificateUrl, manageUrl }
 */
export function welcomeEmail(details) {
  const { nonprofitName, kind, firstName, itemName, interval, certificateUrl: cert, manageUrl: manage } = details;
  const once = interval === "once";
  const everyone = kind === "animal" ? "every animal" : "everyone";
  const subject = once ? `Thank you for your gift to ${nonprofitName}` : `Welcome! You're sponsoring ${itemName}`;
  const lines = once
    ? [`Thank you for your gift. It helps ${itemName} and ${everyone} at ${nonprofitName}.`, "Here's your photo certificate to keep or print."]
    : [`Thank you for sponsoring ${itemName}. Your gift helps ${everyone} at ${nonprofitName}, and you'll get photos and news about ${itemName} along the way.`, "Here's your photo certificate to keep or print."];
  const footer = once ? { text: "", html: "" } : manageFooter(manage);
  const text = [`Hi ${firstName},`, "", ...lines.flatMap((l) => [l, ""]), `Your certificate: ${cert}`, "", `With thanks,`, `${nonprofitName}, via Cover`,
    ...(footer.text ? ["", "---", footer.text] : [])].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: once ? "Thank you!" : `Welcome to ${itemName}'s team`, greeting: `Hi ${firstName},`, lines,
    buttonText: "See my certificate", buttonUrl: cert, closing: ["With thanks,", nonprofitName],
    footer: `${footer.html ? `${footer.html}<br>` : ""}Sent by Cover for ${escapeHtml(nonprofitName)}`,
  });
  return { subject, text, html };
}

/**
 * The email the person who was GIVEN a sponsorship gets on the day the giver picked.
 * details: { nonprofitName, kind, recipientName, giverName, itemName, interval, message, certificateUrl, stopUrl }
 */
export function giftEmail(details) {
  const { nonprofitName, recipientName, giverName, itemName, interval, message, certificateUrl: cert, stopUrl } = details;
  const once = interval === "once";
  const subject = `${giverName} sponsored ${itemName} for you`;
  const lines = once
    ? [`${giverName} made a gift to ${nonprofitName} in your name, for ${itemName}.`, "Here's your photo certificate to keep or print."]
    : [`${giverName} sponsored ${itemName} at ${nonprofitName} for you. You'll get photos and news about ${itemName} along the way.`, "Here's your photo certificate to keep or print."];
  const text = [`Hi ${recipientName},`, "", ...lines.flatMap((l) => [l, ""]), ...(message ? [`"${message}" (${giverName})`, ""] : []),
    `Your certificate: ${cert}`, "", `With thanks,`, `${nonprofitName}, via Cover`, ...(once ? [] : ["", "---", `Stop these updates: ${stopUrl}`])].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: `A gift from ${giverName}`, greeting: `Hi ${recipientName},`, lines, quote: message || null,
    buttonText: "See my certificate", buttonUrl: cert, closing: ["With thanks,", nonprofitName],
    footer: `${once ? "" : `<a href="${escapeHtml(stopUrl)}" style="color:#6B747C">Stop these updates</a> · `}Sent by Cover for ${escapeHtml(nonprofitName)}`,
  });
  return { subject, text, html };
}

/**
 * The reminder an owner gets a week before a scheduled update.
 * details: { nonprofitName, followLabel, dueLabel, dashboardUrl, sponsorCount }
 */
export function reminderEmail(details) {
  const { nonprofitName, followLabel, dueLabel, dashboardUrl, sponsorCount } = details;
  const subject = `Time for your ${dueLabel} update to sponsors`;
  const lines = [
    `Your sponsors are expecting their ${dueLabel} update from ${nonprofitName}. A photo and one line about each of your ${followLabel.toLowerCase()} is plenty.`,
    `${sponsorCount === 1 ? "1 sponsor" : `${sponsorCount} sponsors`} will get it. Open your dashboard, go to ${followLabel}, and tap "Post update" on each one.`,
  ];
  const text = ["Hi,", "", ...lines.flatMap((l) => [l, ""]), `Your dashboard: ${dashboardUrl}`, "", "Cover"].join("\n");
  const html = afterSignupHtml({
    eyebrow: "Cover", heading: `Your ${dueLabel} update is coming up`, greeting: "Hi,", lines,
    buttonText: "Open my dashboard", buttonUrl: dashboardUrl, closing: null, footer: "Sent by Cover. You get this because you run a sponsor page.",
  });
  return { subject, text, html };
}

// ---------- Stripe alerts and gift confirmations (Nov 25, 2026) ----------

/**
 * To a nonprofit's owner (and Cover) when Stripe needs something for their account.
 * details: { nonprofitName, problem, dashboardUrl }
 */
export function stripeAlertEmail(details) {
  const { nonprofitName, problem, dashboardUrl } = details;
  const subject = `Stripe needs one more thing for ${nonprofitName}`;
  const lines = [problem, "It usually takes a few minutes. Open your dashboard, go to Payments & payouts, and follow the steps there."];
  const text = ["Hi,", "", ...lines.flatMap((l) => [l, ""]), `Your dashboard: ${dashboardUrl}`, "", "Cover"].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: "Stripe needs one more thing", greeting: "Hi,", lines,
    buttonText: "Open Payments & payouts", buttonUrl: dashboardUrl, closing: null,
    footer: "Sent by Cover. You get this because you run a sponsor page on Cover.",
  });
  return { subject, text, html };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Thursday, December 25" for a "2026-12-25" day (no time zone surprises). */
export function dayLabel(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay ?? "");
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * To the person who BOUGHT a gift sponsorship, right after paying: when it arrives and a preview.
 * details: { nonprofitName, giverName, recipientName, itemName, sendOn, today, message, certificateUrl, manageUrl }
 * sendOn and today are "YYYY-MM-DD" (Eastern). To change the day, they reply (no self-serve change yet).
 */
export function giftSetEmail(details) {
  const { nonprofitName, giverName, recipientName, itemName, sendOn, today, message, certificateUrl: cert, manageUrl: manage } = details;
  const arrivesToday = !sendOn || sendOn <= today;
  const when = arrivesToday ? "today" : `on ${dayLabel(sendOn)}`;
  const subject = `Your gift for ${recipientName} is set`;
  const lines = [
    `Thank you. We'll email ${recipientName} ${when} with ${itemName}'s photo certificate${message ? " and your message" : ""}. From then on, they'll get the photos and news.`,
    arrivesToday ? "Here's a preview of the certificate they'll get." : `Here's a preview of the certificate. To change the day or your message before then, just reply to this email.`,
  ];
  const footer = manageFooter(manage);
  const text = [`Hi ${giverName},`, "", ...lines.flatMap((l) => [l, ""]), ...(message ? [`Your message: "${message}"`, ""] : []),
    `Certificate preview: ${cert}`, "", "With thanks,", `${nonprofitName}, via Cover`, ...(footer.text ? ["", "---", footer.text] : [])].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: "Your gift is set", greeting: `Hi ${giverName},`, lines, quote: message || null,
    buttonText: "Preview the certificate", buttonUrl: cert, closing: ["With thanks,", nonprofitName],
    footer: `${footer.html ? `${footer.html}<br>` : ""}Sent by Cover for ${escapeHtml(nonprofitName)}`,
  });
  return { subject, text, html };
}
