// guards.ts - checks shared by Cover's public server functions (checkout and the My gifts link form):
// Cloudflare's bot check and keyed fingerprints for rate limits.

import { requireSetting } from "./clients.ts";
import { BadRequest, botCheckOutcome, TURNSTILE_VERIFY_URL } from "./sponsorship.js";

/** A keyed fingerprint (HMAC-SHA256), so the rate-limit table never holds a real IP or email. */
export async function fingerprint(text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(requireSetting("EMAIL_LINK_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare Turnstile. Off until TURNSTILE_SECRET_KEY is set in Supabase secrets. */
export async function checkNotABot(body: unknown, ip: string): Promise<void> {
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
