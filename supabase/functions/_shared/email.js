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

import { amountPhrase, dollars, easternMonthName, helpsList, howOften, nameList, pageBasics, togetherLabel } from "./pack.js";

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


// ---------- The look: Cover's brand (moss and cream), shared by every email ----------
// Full photo, square edges, thin lines, no boxes or shadows. Fonts fall back to Helvetica and Georgia
// in email apps that don't load web fonts. Everything anyone typed goes through escapeHtml.

const INK = "#2B2A26";
const INK_SOFT = "#5D5B56";
const MOSS = "#4B5A2A";
const DEEP = "#2F3A24";
const CREAM = "#F4EFE6";
const PAPER = "#FAF7F1";
const LINE = "#D9D2C3";
const LIGHT_SAGE = "#B4BE93";
const OUTSIDE = "#E9E3D7";
const SANS = "'DM Sans',Helvetica,Arial,sans-serif";
const HEADLINE = "'Space Grotesk',Helvetica,Arial,sans-serif";
const SERIF = "'Fraunces',Georgia,'Times New Roman',serif";
const FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&amp;family=Fraunces:ital,wght@1,460&amp;family=Space+Grotesk:wght@700&amp;display=swap">';
const GAP = "&nbsp;&nbsp;&nbsp;"; // between footer links (the brand uses no dot separators)

const MANAGE_LINK_TEXT = "Manage my gift";
const REPLY_FOOTER = "To change or cancel your monthly gift, just reply to this email.";
const WALL_LINK_TEXT = "Take my name off the thank-you wall";

/** Make text safe to put inside an email's HTML. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

const e = escapeHtml;
const safePhoto = (url) => (/^https:\/\/[^\s"'<>]+$/.test(String(url ?? "")) ? url : "");
const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");

function para(html, { size = 16, color = INK_SOFT, margin = "0 0 16px" } = {}) {
  return `<p style="margin:${margin};font-family:${SANS};font-size:${size}px;line-height:1.6;color:${color}">${html}</p>`;
}

function smallLabel(text) {
  return `<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${MOSS}">${e(text)}</p>`;
}

/** The one italic accent phrase a heading may have. */
function accent(text, color = MOSS) {
  return `<span style="font-family:${SERIF};font-style:italic;font-weight:460;color:${color}">${e(text)}</span>`;
}

function buttonHtml(text, url) {
  return `<a href="${e(url)}" style="display:inline-block;background:${MOSS};color:${CREAM};font-family:${SANS};font-weight:600;font-size:15px;text-decoration:none;padding:12px 20px">${e(text)}</a>`;
}

function quoteHtml(text) {
  return `<p style="margin:0 0 16px;padding:16px 0 16px 16px;border-left:2px solid ${MOSS};font-family:${SANS};font-size:19px;line-height:1.5;color:${INK}">"${e(text)}"</p>`;
}

function photoHtml(url, alt, height, focus = "50% 38%") {
  const src = safePhoto(url);
  if (!src) return "";
  return `<img src="${e(src)}" alt="${e(alt)}" width="600" style="display:block;width:100%;height:${height}px;object-fit:cover;object-position:${e(focus)}">`;
}

/** A thin-lined section inside the email's body. */
function block(inner, last = false) {
  return `<div style="border-top:1px solid ${LINE};padding:24px 0${last ? " 0" : ""}">${inner}</div>`;
}

function sentBy(nonprofitName) {
  return nonprofitName ? `Sent by Cover for ${e(nonprofitName)}.` : "Sent by Cover.";
}

/**
 * Every email's frame. dark: the heading sits on a deep moss band under the photo (the welcome pack);
 * otherwise the heading comes first and the photo under it (updates).
 */
function emailShell({ eyebrow, titleHtml, photo = "", dark = false, body, footer }) {
  const head = dark
    ? `<div style="background:${DEEP};padding:32px">
      <p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${LIGHT_SAGE}">${e(eyebrow)}</p>
      <h1 style="margin:0;font-family:${HEADLINE};font-weight:700;font-size:34px;line-height:1.1;letter-spacing:-0.018em;color:${CREAM}">${titleHtml}</h1>
    </div>`
    : `<div style="padding:32px 32px ${photo ? "24px" : "0"}">
      <p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${MOSS}">${e(eyebrow)}</p>
      <h1 style="margin:0;font-family:${HEADLINE};font-weight:700;font-size:30px;line-height:1.15;letter-spacing:-0.018em;color:${INK}">${titleHtml}</h1>
    </div>`;
  const top = dark ? `${photo}${head}` : `${head}${photo}`;
  return `${FONTS}<div style="background:${OUTSIDE};padding:24px 12px;font-family:${SANS}">
  <div style="max-width:600px;margin:0 auto;background:${CREAM}">
    ${top}
    <div style="padding:${photo || dark ? "32px" : "24px 32px 32px"}">${body}</div>
    <div style="padding:24px 32px;border-top:1px solid ${LINE};font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_SOFT};text-align:center">${footer.filter(Boolean).join("<br>")}</div>
  </div>
</div>`;
}

/** Join an email's plain-text lines, never leaving two blank lines in a row or one at the end. */
function textLines(lines) {
  return lines.filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trimEnd();
}

/**
 * The footer's first line: a "Manage my gift" link (card, amount, cancel), or the old reply line if there's
 * no link. For someone who was GIVEN the sponsorship, it says who it's from instead (the giver manages it).
 */
function manageFooter(url, giftFrom = null) {
  if (giftFrom) {
    const line = `This sponsorship is a gift from ${giftFrom}.`;
    return { text: line, html: e(line) };
  }
  if (!url) return { text: REPLY_FOOTER, html: e(REPLY_FOOTER) };
  return {
    text: `${MANAGE_LINK_TEXT} (card, amount or cancel): ${url}`,
    html: `<a href="${e(url)}" style="color:${INK_SOFT}">${MANAGE_LINK_TEXT}</a> (card, amount or cancel)`,
  };
}

/** The extra footer link for sponsors on the thank-you wall (text and HTML). Empty when there's no link. */
function wallLink(wallUrl) {
  if (!wallUrl) return { text: "", html: "" };
  return { text: `${WALL_LINK_TEXT}: ${wallUrl}`, html: `${GAP}<a href="${e(wallUrl)}" style="color:${INK_SOFT}">${WALL_LINK_TEXT}</a>` };
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
  const html = emailShell({
    eyebrow: "Cover",
    titleHtml: `Your ${accent("sponsorships")}`,
    body: para("See everyone you sponsor and their updates. Update your card, change the amount, switch who you follow, or cancel.")
      + buttonHtml("Open my sponsorships", url),
    footer: [`The link works for ${MANAGE_LINK_DAYS} days. If you didn't ask for it, you can ignore this email.`, sentBy("")],
  });
  return { subject, text, html };
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

  const text = textLines([
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
  ]);

  const html = emailShell({
    eyebrow: nonprofitName,
    titleHtml: animal ? `${e(finishedName)} ${accent("went home!")}` : `${e(finishedName)} ${accent("has wrapped up")}`,
    body: [
      para(`Hi ${e(firstName)},`, { color: INK, size: 17 }),
      para(e(news)),
      ownerNote ? quoteHtml(ownerNote) : "",
      para(e(gift)),
      para(e(ask), { margin: "0 0 24px" }),
      pickUrl ? buttonHtml(button, pickUrl) : "",
      para(`Thank you for being a sponsor.<br>${e(nonprofitName)}`, { margin: "24px 0 0" }),
    ].join("\n"),
    footer: [footer.html, `<a href="${e(stopUrl)}" style="color:${INK_SOFT}">Stop these updates</a>${wall.html}`, sentBy(nonprofitName)],
  });

  return { subject, text, html };
}

/**
 * What a gift helps with, for the update email's "this month" line:
 * { title: "This month, your $25 helped with", text: "Food, vet care... for every dog at Lucky Pup Rescue." }
 */
function giftHelpsLines({ nonprofitName, kind, one, helps, amountCents, interval, giftFrom }) {
  const amount = amountPhrase(amountCents, interval);
  const title = giftFrom ? `${giftFrom}'s gift helps with`
    : amount && interval === "year" ? `Your ${amount} helps with`
    : amount && interval !== "once" ? `This month, your ${dollars(amountCents)} helped with`
    : "Your gift helps with";
  const animal = kind === "animal";
  const who = animal ? `every ${one || "animal"} at ${nonprofitName}` : nonprofitName;
  const list = helpsList(helps);
  const text = list ? `${capitalize(list)} ${animal ? "for" : "at"} ${who}.` : animal ? `${capitalize(who)}.` : `Everything at ${nonprofitName}.`;
  return { title, text };
}

/**
 * An owner's update about one dog or program, sent to its sponsors (the monthly update, Nov 25 design).
 * details: { nonprofitName, kind, firstName, itemName, body, photoUrl, photoFocus, stopUrl, wallUrl, manageUrl, giftFrom,
 *            startedAt, amountCents, interval, helps, one, sentAt }
 * photoUrl is optional and must be an https address (checked by the database too). The "2 months together"
 * and "your $25 helped with" lines show when startedAt and amountCents are given.
 */
export function updateEmail(details) {
  const { nonprofitName, firstName, itemName, body, photoUrl, photoFocus, stopUrl, wallUrl, manageUrl: manage, giftFrom,
    startedAt, sentAt } = details;
  const wall = wallLink(wallUrl);
  const footer = manageFooter(manage, giftFrom);
  const month = easternMonthName(sentAt ? new Date(sentAt) : new Date());
  const subject = `${itemName}'s ${month} update`;
  const photo = safePhoto(photoUrl);
  const together = togetherLabel(startedAt, sentAt ? new Date(sentAt) : new Date());
  const helps = giftHelpsLines(details);
  const allUpdates = manage && !giftFrom ? manage : null; // My sponsorships shows every update

  const text = textLines([
    `Hi ${firstName},`,
    "",
    `${itemName}'s ${month} update from ${nonprofitName}:`,
    "",
    `"${body}"`,
    "",
    photo ? `Photo: ${photo}\n` : "",
    together ? `${together}: you and ${itemName}, together.` : "",
    `${helps.title} ${helps.text[0].toLowerCase()}${helps.text.slice(1)}`,
    "",
    allUpdates ? `See all of ${itemName}'s updates: ${allUpdates}\n` : "",
    `Thank you for being on ${itemName}'s team.`,
    `${nonprofitName}, via Cover`,
    "",
    "---",
    footer.text,
    `Stop updates about ${itemName}: ${stopUrl}`,
    wall.text,
  ]);

  const numbers = `<div style="border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};margin:0 0 24px">
      ${together ? `<div style="padding:16px 0;border-bottom:1px solid ${LINE}">
        <p style="margin:0;font-family:${HEADLINE};font-weight:700;font-size:30px;letter-spacing:-0.018em;color:${INK}">${e(together)}</p>
        <p style="margin:4px 0 0;font-family:${SANS};font-size:14px;color:${INK_SOFT}">you and ${e(itemName)}, together</p>
      </div>` : ""}
      <div style="padding:16px 0">
        <p style="margin:0 0 4px;font-family:${SANS};font-weight:600;font-size:15px;color:${INK}">${e(helps.title)}</p>
        <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.5;color:${INK_SOFT}">${e(helps.text)}</p>
      </div>
    </div>`;

  const html = emailShell({
    eyebrow: nonprofitName,
    titleHtml: `${e(itemName)}'s ${accent(`${month} update`)}`,
    photo: photoHtml(photo, itemName, 340, photoFocus),
    body: [
      para(`Hi ${e(firstName)},`, { color: INK, size: 17 }),
      quoteHtml(body),
      para(`From ${e(nonprofitName)}`, { size: 14, margin: "0 0 24px" }),
      numbers,
      allUpdates ? buttonHtml(`See all of ${itemName}'s updates`, allUpdates) : "",
      para(`Thank you for being on ${e(itemName)}'s team.<br>${e(nonprofitName)}`, { margin: "24px 0 0" }),
    ].join("\n"),
    footer: [footer.html, `<a href="${e(stopUrl)}" style="color:${INK_SOFT}">Stop updates about ${e(itemName)}</a>${wall.html}`, sentBy(nonprofitName)],
  });

  return { subject, text, html };
}

// ---------- After signing up: the welcome pack, gifts, owner reminders ----------

/** The photo certificate's address: covergiving.com/certificate.html?t=... (a signed, never-expiring link). */
export function certificateUrl(token) {
  return `${SITE_URL}/certificate.html?t=${encodeURIComponent(token)}`;
}

/** The shared simple email (a greeting, a few lines, one button), in the new look. */
function afterSignupHtml({ eyebrow, heading, greeting, lines, quote, buttonText, buttonUrl, closing, footer, photo = "" }) {
  return emailShell({
    eyebrow,
    titleHtml: e(heading),
    photo,
    body: [
      greeting ? para(e(greeting), { color: INK, size: 17 }) : "",
      ...lines.map((line) => para(e(line))),
      quote ? quoteHtml(quote) : "",
      buttonUrl ? `<div style="margin:8px 0 0">${buttonHtml(buttonText, buttonUrl)}</div>` : "",
      closing ? para(`${e(closing[0])}<br>${e(closing[1])}`, { margin: "24px 0 0" }) : "",
    ].join("\n"),
    footer: [footer],
  });
}

/** The small certificate preview in the welcome pack: the photo, their name, who they sponsor. */
function certificatePreview({ photo, focus, holderName, itemName, once, cert }) {
  const thumb = photo
    ? `<img src="${e(photo)}" alt="" width="104" style="display:block;width:104px;height:64px;object-fit:cover;object-position:${e(focus)}">`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td style="width:120px;vertical-align:middle;padding:0 16px 0 0">
        <div style="width:104px;background:${PAPER};border:1px solid ${LINE};padding:8px;text-align:center">
          ${thumb}
          <p style="margin:6px 0 0;font-family:${SERIF};font-style:italic;font-size:14px;color:${MOSS}">${e(holderName)}</p>
          <p style="margin:0;font-family:${SANS};font-size:10px;color:${INK_SOFT}">${once ? "helped" : "sponsors"} ${e(itemName)}</p>
        </div>
      </td>
      <td style="vertical-align:middle">
        <p style="margin:0 0 4px;font-family:${SANS};font-weight:600;font-size:16px;color:${INK}">Your photo certificate</p>
        <p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.5;color:${INK_SOFT}">With your name and ${e(itemName)}'s photo, ready to keep or print.</p>
        ${buttonHtml("See my certificate", cert)}
      </td>
    </tr></table>`;
}

/**
 * The welcome pack, right after someone starts sponsoring (or gives once): a thank-you, a short letter
 * from the dog built from what the owner wrote on its profile, the photo certificate, and what happens next.
 * details: { nonprofitName, kind, firstName, itemName, interval, certificateUrl, manageUrl,
 *            isItem, isGroup, about, photoUrl, photoFocus, amountCents, holderName, page }
 * page is the nonprofit's page settings (what a gift helps with, first person or not, update schedule).
 * Only promises what Cover really does: updates only when they follow someone; nothing for one-time gifts.
 */
export function welcomeEmail(details) {
  const { nonprofitName, kind, firstName, itemName, interval, certificateUrl: cert, manageUrl: manage,
    isItem = true, isGroup = false, about, photoUrl, photoFocus = "50% 38%", amountCents, holderName } = details;
  const basics = pageBasics(details.page, kind);
  const once = interval === "once";
  const animal = kind === "animal";
  const everyOne = animal ? `every ${basics.one}` : "everyone";
  const amount = amountPhrase(amountCents, interval);
  const photo = safePhoto(photoUrl);
  const list = helpsList(basics.helps);
  const letter = isItem && animal && basics.firstPerson;
  const name = isItem ? itemName : nonprofitName;

  const subject = once ? `Thank you for your gift to ${nonprofitName}` : `Welcome to ${name}'s team, ${firstName}`;
  const intro = once
    ? `Thank you for your ${amount ? `${amount} ` : ""}gift. It helps ${isItem ? `${itemName} and ` : ""}${everyOne} at ${nonprofitName}. Here's your thank-you pack.`
    : isItem
    ? `Thank you for sponsoring ${itemName}. Your ${amount ?? "gift"} helps ${everyOne} at ${nonprofitName}, and ${itemName} is the one you'll hear about. Here's your welcome pack.`
    : `Thank you for sponsoring ${nonprofitName}. Your ${amount ?? "gift"} helps ${everyOne} there. Here's your welcome pack.`;

  // The letter: in the dog's voice when the page talks in first person, otherwise "About ...".
  const aboutText = typeof about === "string" && about.trim() ? about.trim() : "";
  const helpsLine = list ? `Your gift helps with ${list} for ${isGroup ? "us" : "me"} and ${everyOne} here.` : `Your gift helps ${isGroup ? "us" : "me"} and ${everyOne} here.`;
  const letterLines = letter ? [
    aboutText ? `Here's what the people at ${nonprofitName} say about ${isGroup ? "us" : "me"}: "${aboutText}"` : "",
    `${helpsLine}${once ? "" : ` ${isGroup ? "We'll" : "I'll"} send you photos and news along the way.`}`,
  ].filter(Boolean) : [];
  const greetingLine = isGroup ? `Hi ${firstName}! Meet the ${itemName}.` : `Hi ${firstName}! I'm ${itemName}.`;
  const signOff = isGroup ? `Love, the ${itemName}` : `Love, ${itemName}`;
  const thanksLine = once ? "Thank you for helping." : `Thank you for being on ${isGroup ? "our" : "my"} team.`;

  const next = once ? [] : [
    isItem ? ["This week", `your first photo of ${itemName}, from ${nonprofitName}.`] : null,
    isItem ? [howOften(basics.updateMonths), `a new photo and a line about how ${itemName} is doing.`] : null,
    isItem && animal ? [`The day ${itemName} ${basics.finishVerb}`, `the good news, and the chance to meet the next ${basics.one} who needs you.`] : null,
    isItem && !animal ? [`If ${itemName} ${basics.finishVerb}`, "we'll tell you, and you can pick what to follow next."] : null,
    manage ? ["Anytime", "see everyone you sponsor, their updates and your receipts on My sponsorships."] : null,
  ].filter(Boolean);

  const footer = once ? { text: "", html: "" } : manageFooter(manage);
  const text = textLines([
    `Hi ${firstName},`,
    "",
    intro,
    "",
    ...(letter ? [greetingLine, ...letterLines, thanksLine, signOff, ""] : aboutText && isItem ? [`About ${itemName}: ${aboutText}`, ""] : []),
    `Your photo certificate: ${cert}`,
    "",
    ...(next.length ? ["What happens next", ...next.map(([when, what]) => `${when}: ${what}`), ""] : []),
    manage && !once ? `My sponsorships: ${manage}` : "",
    "",
    "With thanks,",
    `${nonprofitName}, via Cover`,
    ...(footer.text ? ["", "---", footer.text] : []),
  ]);

  const letterHtml = letter
    ? block(smallLabel(`A note from ${itemName}`)
      + `<p style="margin:0 0 16px;font-family:${SERIF};font-style:italic;font-weight:460;font-size:26px;line-height:1.25;color:${MOSS}">${e(greetingLine)}</p>`
      + letterLines.map((line) => para(e(line))).join("")
      + para(`${e(thanksLine)}<br><span style="font-family:${SERIF};font-style:italic;font-size:20px;color:${MOSS}">${e(signOff)}</span>`, { margin: "0" }))
    : aboutText && isItem
    ? block(smallLabel(`About ${itemName}`) + para(e(aboutText)) + (list ? para(e(`Your gift helps with ${list} at ${nonprofitName}.`), { margin: "0" }) : ""))
    : "";
  const nextHtml = next.length
    ? block(smallLabel("What happens next") + next.map(([when, what], i) => {
      const words = when === "Anytime" && manage
        ? `see everyone you sponsor, their updates and your receipts on <a href="${e(manage)}" style="color:${MOSS};font-weight:600">My sponsorships</a>.`
        : e(what);
      return para(`<b style="color:${INK}">${e(when)}:</b> ${words}`, { color: INK, margin: i === next.length - 1 ? "0" : "0 0 12px" });
    }).join(""), true)
    : "";

  const html = emailShell({
    eyebrow: nonprofitName,
    dark: true,
    photo: photoHtml(photo, name, 300, photoFocus),
    titleHtml: once ? `Thank you ${accent("from all of us.", LIGHT_SAGE)}` : `Welcome to ${accent(`${name}'s team.`, LIGHT_SAGE)}`,
    body: [
      para(`Hi ${e(firstName)},`, { color: INK, size: 17 }),
      para(e(intro), { color: INK, size: 17, margin: "0 0 24px" }),
      letterHtml,
      block(certificatePreview({ photo, focus: photoFocus, holderName: holderName || firstName, itemName: name, once, cert }), !nextHtml),
      nextHtml,
    ].join("\n"),
    footer: [footer.html, sentBy(nonprofitName)],
  });
  return { subject, text, html };
}

/**
 * The email the person who was GIVEN a sponsorship gets on the day the giver picked.
 * details: { nonprofitName, kind, recipientName, giverName, itemName, interval, message, certificateUrl, stopUrl, photoUrl, photoFocus }
 */
export function giftEmail(details) {
  const { nonprofitName, recipientName, giverName, itemName, interval, message, certificateUrl: cert, stopUrl, photoUrl, photoFocus } = details;
  const once = interval === "once";
  const subject = `${giverName} sponsored ${itemName} for you`;
  const lines = once
    ? [`${giverName} made a gift to ${nonprofitName} in your name, for ${itemName}.`, "Here's your photo certificate to keep or print."]
    : [`${giverName} sponsored ${itemName} at ${nonprofitName} for you. You'll get photos and news about ${itemName} along the way.`, "Here's your photo certificate to keep or print."];
  const text = [`Hi ${recipientName},`, "", ...lines.flatMap((l) => [l, ""]), ...(message ? [`"${message}" (${giverName})`, ""] : []),
    `Your certificate: ${cert}`, "", `With thanks,`, `${nonprofitName}, via Cover`, ...(once ? [] : ["", "---", `Stop these updates: ${stopUrl}`])].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: `A gift from ${giverName}`, greeting: `Hi ${recipientName},`, lines, quote: message || null,
    buttonText: "See my certificate", buttonUrl: cert, closing: ["With thanks,", nonprofitName], photo: photoHtml(photoUrl, itemName, 300, photoFocus),
    footer: `${once ? "" : `<a href="${e(stopUrl)}" style="color:${INK_SOFT}">Stop these updates</a><br>`}${sentBy(nonprofitName)}`,
  });
  return { subject, text, html };
}

/**
 * The reminder an owner gets a week before an update month they picked.
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

/**
 * To a nonprofit's owner when a new sponsor has had no first photo after 5 days (the welcome pack
 * told them to expect one in the first week).
 * details: { nonprofitName, names: ["Falkor"], dashboardUrl }
 */
export function firstUpdateNudgeEmail(details) {
  const { nonprofitName, names, dashboardUrl } = details;
  const who = nameList(names);
  const many = (names ?? []).length > 1;
  const subject = many ? `New sponsors are waiting for a first photo` : `${who}'s new sponsor is waiting for a first photo`;
  const lines = [
    `${who} ${many ? "have" : "has"} a new sponsor who hasn't had a first update yet. Their welcome email said a first photo comes in the first week.`,
    `A photo and one line takes about a minute. Open your dashboard, find ${many ? "each one" : who}, and tap "Post update".`,
  ];
  const text = ["Hi,", "", ...lines.flatMap((l) => [l, ""]), `Your dashboard: ${dashboardUrl}`, "", "Cover"].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: many ? "New sponsors are waiting" : `${who}'s new sponsor is waiting`, greeting: "Hi,", lines,
    buttonText: "Post an update", buttonUrl: dashboardUrl, closing: null, footer: "Sent by Cover. You get this because you run a sponsor page.",
  });
  return { subject, text, html };
}

/**
 * The monthly reminder, 5 days before the month ends, for every dog (or program) with sponsors and no update yet that month.
 * details: { nonprofitName, monthLabel, names: ["Falkor", "Becky"], dashboardUrl }
 */
export function monthlyReminderEmail(details) {
  const { nonprofitName, monthLabel, names, dashboardUrl } = details;
  const who = nameList(names);
  const many = (names ?? []).length > 1;
  const subject = `Time for ${monthLabel} updates to your sponsors`;
  const lines = [
    `${who} ${many ? "have" : "has"} sponsors waiting on a ${monthLabel} update. There are 5 days left in the month.`,
    `${many ? "A photo and one line each is plenty, about a minute per update." : "A photo and one line is plenty, about a minute."} Open your dashboard and tap "Post update".`,
  ];
  const text = ["Hi,", "", ...lines.flatMap((l) => [l, ""]), `Your dashboard: ${dashboardUrl}`, "", "Cover"].join("\n");
  const html = afterSignupHtml({
    eyebrow: nonprofitName, heading: `${monthLabel} updates are due`, greeting: "Hi,", lines,
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
    footer: `${footer.html ? `${footer.html}<br>` : ""}${sentBy(nonprofitName)}`,
  });
  return { subject, text, html };
}
