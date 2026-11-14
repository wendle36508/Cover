// auth-link.js - finishes signing in from the link in Cover's sign-in email.
// The email's link carries a one-time token (token_hash). This page checks it with Supabase
// directly, so it works on any device or browser, even if the link was requested somewhere else.

const PROBLEMS = {
  expired: "That sign-in link expired or was already used. Enter your email to get a fresh one.",
  failed: "That sign-in link didn't work. Request a new one below.",
};

/** What a sign-in link in the address bar contains. Pure, so it's tested on its own. */
export function readSignInLink(href) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") || "email";
  const errorCode = url.searchParams.get("error_code") || hash.get("error_code");
  const errorText = url.searchParams.get("error_description") || hash.get("error_description");
  if (tokenHash) return { kind: "token", tokenHash, type: ["email", "magiclink", "signup", "invite"].includes(type) ? type : "email" };
  if (errorCode || errorText) return { kind: "error", expired: /expired|invalid|otp/i.test(`${errorCode} ${errorText}`) };
  if (hash.get("access_token")) return { kind: "session" }; // older links; the Supabase client handles these
  return { kind: "none" };
}

/** The message the sign-in page shows for ?problem=..., or "" for none. */
export function problemMessage(code) {
  return PROBLEMS[code] ?? "";
}

/**
 * Finish a sign-in from the current address, then tidy the address bar.
 * Returns "signed_in", "none", or a problem code ("expired" or "failed").
 */
export async function finishSignInFromLink(supabase, location = window.location, history = window.history) {
  const link = readSignInLink(location.href);
  const tidy = () => history.replaceState(null, "", location.pathname);
  if (link.kind === "token") {
    const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type === "magiclink" || link.type === "signup" ? "email" : link.type });
    tidy();
    if (!error) return "signed_in";
    return /expired|invalid|otp/i.test(`${error.code ?? ""} ${error.message ?? ""}`) ? "expired" : "failed";
  }
  if (link.kind === "error") {
    tidy();
    return link.expired ? "expired" : "failed";
  }
  return link.kind === "session" ? "signed_in" : "none";
}
