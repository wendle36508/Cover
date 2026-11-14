// supabase.js - the signed-in connection to Cover's database, for the sign-in page and dashboard.
// Loaded from a pinned version on jsDelivr. Uses only the public key: what a signed-in person can
// see or change is decided by the database's safety rules, not by this file.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

// "implicit" sign-in: the email link carries the sign-in itself, so it works even when someone
// asks for the link on a laptop and opens the email on their phone (the stricter "pkce" mode
// only works in the same browser that asked).
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

/** The address of a page next to this one (works locally and once the site is online). */
export function pageUrl(file) {
  return new URL(file, window.location.href).href.split("?")[0].split("#")[0];
}

/** Call one of Cover's server functions as the signed-in person. Throws with a friendly message. */
export async function callServer(name, body) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("We couldn't reach Cover's server. Check your connection and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Something went wrong. Please try again.");
  return result;
}
