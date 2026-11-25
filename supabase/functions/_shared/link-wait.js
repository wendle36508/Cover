// link-wait.js - sign in on the computer by opening the emailed link on a phone (Nov 25, 2026).
// Plain JavaScript so Node can test it. Used by the sponsor-portal function.
//
//   1. The computer asks for a link with a long random secret it keeps to itself. Cover stores only a
//      scrambled copy (SHA-256), plus a 4-digit number the computer shows.
//   2. The email's link carries the waiting sign-in's id. On the phone, the page shows the number and asks
//      "Does your computer show 4821?". Only a yes (with the link's own proof of the email) approves it.
//   3. The computer checks every few seconds with its secret; once approved, it gets its own My sponsorships
//      link token, once. After 15 minutes the waiting sign-in is gone.

export const WAIT_MINUTES = 15;
export const POLL_SECONDS = 3;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The computer's secret if it looks right (long and random-looking), else null. */
export function cleanWaitSecret(value) {
  return typeof value === "string" && SECRET.test(value) ? value : null;
}

/** A waiting sign-in's id if it looks like one, else null. */
export function cleanWaitId(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/** A random 4-digit number, "0000" to "9999". */
export function newWaitCode(random = crypto.getRandomValues(new Uint32Array(1))[0]) {
  return String(random % 10000).padStart(4, "0");
}

/** SHA-256 of some text, as 64 hex characters. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two strings without leaking where they differ through timing. */
export function sameText(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Where a waiting sign-in stands: "expired", "used", "approved" or "waiting". */
export function waitState(row, now = new Date()) {
  if (!row) return "expired";
  if (row.used_at) return "used";
  if (now.getTime() - new Date(row.created_at).getTime() > WAIT_MINUTES * 60000) return "expired";
  return row.approved_at ? "approved" : "waiting";
}

/** The emailed link, naming the waiting sign-in so the phone can approve it. */
export function linkWithWait(url, waitId) {
  return waitId ? `${url}&w=${encodeURIComponent(waitId)}` : url;
}
