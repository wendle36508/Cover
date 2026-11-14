// email.js - sponsor emails: the secure links inside them and the wording (plain JavaScript,
// tested with Node, used by the sponsor-email server function).
//
// Links: every email carries links like covergiving.com/updates.html?a=stop&t=TOKEN. The token
// names one sponsorship and what the link may do, and is signed with a secret only Cover's server
// knows, so nobody can make a link for someone else's sponsorship.
//   * "stop" links (stop or restart updates) never expire, as people expect from unsubscribe links.
//   * "pick" links (choose a different buddy) last 30 days.

export const SITE_URL = "https://covergiving.com";
export const FROM_ADDRESS = "hello@covergiving.com";
export const REPLY_TO = "hello@covergiving.com"; // Tanner's call: replies (like cancel requests) come to Cover
export const PICK_LINK_DAYS = 30;
const PURPOSES = new Set(["stop", "pick"]);

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
 * details: { nonprofitName, kind, firstName, finishedName, ownerNote, pickUrl, stopUrl }
 * Tanner's call (Nov 14): sponsors are never moved to a new buddy automatically. They go back to
 * following the whole nonprofit, and the email asks if they'd like to pick someone new.
 * pickUrl is null when there's no one else on the page to pick.
 */
export function adoptionEmail(details) {
  const { nonprofitName, kind, firstName, finishedName, ownerNote, pickUrl, stopUrl } = details;
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
  const footer = "To change or cancel your monthly gift, just reply to this email.";

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
    footer,
    `Stop these updates: ${stopUrl}`,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");

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
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6B747C;text-align:center">${e(footer)}<br>
    <a href="${e(stopUrl)}" style="color:#6B747C">Stop these updates</a> · Sent by Cover for ${e(nonprofitName)}</p>
</div>`;

  return { subject, text, html };
}
