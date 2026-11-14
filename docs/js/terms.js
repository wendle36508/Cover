// terms.js - remembers that someone agreed to Cover's Terms of Service on the sign-in page, and
// records it on their account once they're signed in (who, which version, when).
//
// Change TERMS_VERSION whenever docs/terms.html changes in a way people should agree to again.

export const TERMS_VERSION = "2026-11-14";
const PENDING_KEY = "cover.termsAgreed";

/** Sign-in page: note in this browser that the box was checked (in case the storage is blocked, the account copy still works). */
export function rememberTermsAgreement(storage = globalThis.localStorage) {
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify({ version: TERMS_VERSION, at: new Date().toISOString() }));
  } catch {
    // Private browsing or blocked storage: the agreement still rides along on the sign-in request.
  }
}

/** Which version this person agreed to: from this browser, or from their account (set when they first signed up). */
export function agreedVersion(user, storage = globalThis.localStorage) {
  let pending = null;
  try {
    pending = JSON.parse(storage?.getItem(PENDING_KEY) ?? "null");
  } catch {
    pending = null;
  }
  const version = pending?.version ?? user?.user_metadata?.terms_version ?? null;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(version ?? "")) ? version : null;
}

/** Dashboard: once signed in, save the agreement on Cover's records (safe to run every visit). */
export async function recordTermsAgreement(supabase, user, storage = globalThis.localStorage) {
  const version = agreedVersion(user, storage);
  if (!version) return false;
  const { error } = await supabase.rpc("record_terms_acceptance", { accepted_version: version });
  if (error) return false;
  try {
    storage?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clean up.
  }
  return true;
}
