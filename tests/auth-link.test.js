// Tests for docs/js/auth-link.js (finishing sign-in from the email link). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { finishSignInFromLink, problemMessage, readSignInLink } from "../docs/js/auth-link.js";

const BASE = "https://covergiving.com/dashboard.html";

test("a link with a one-time token is recognized", () => {
  assert.deepEqual(readSignInLink(`${BASE}?token_hash=abc123&type=email`), { kind: "token", tokenHash: "abc123", type: "email" });
  assert.equal(readSignInLink(`${BASE}?token_hash=abc&type=weird`).type, "email");
  assert.equal(readSignInLink(`${BASE}?token_hash=abc`).type, "email");
});

test("expired or broken links are recognized, from the query or the hash", () => {
  assert.deepEqual(readSignInLink(`${BASE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`), { kind: "error", expired: true });
  assert.deepEqual(readSignInLink(`${BASE}?error_description=Something+else`), { kind: "error", expired: false });
});

test("plain visits and older token links", () => {
  assert.deepEqual(readSignInLink(BASE), { kind: "none" });
  assert.deepEqual(readSignInLink(`${BASE}#access_token=x&refresh_token=y`), { kind: "session" });
});

test("problem messages", () => {
  assert.match(problemMessage("expired"), /expired/);
  assert.match(problemMessage("failed"), /didn't work/);
  assert.equal(problemMessage("nope"), "");
});

function fakes(href, verifyResult) {
  const calls = [];
  const url = new URL(href);
  return {
    calls,
    supabase: { auth: { verifyOtp: async (args) => { calls.push(args); return verifyResult; } } },
    location: { href, pathname: url.pathname },
    history: { replaceState: (_s, _t, path) => calls.push({ tidied: path }) },
  };
}

test("a good token signs in and tidies the address bar", async () => {
  const f = fakes(`${BASE}?token_hash=good&type=magiclink`, { error: null });
  assert.equal(await finishSignInFromLink(f.supabase, f.location, f.history), "signed_in");
  assert.deepEqual(f.calls, [{ token_hash: "good", type: "email" }, { tidied: "/dashboard.html" }]);
});

test("a used or expired token reports expired instead of looping", async () => {
  const f = fakes(`${BASE}?token_hash=old&type=email`, { error: { code: "otp_expired", message: "Email link is invalid or has expired" } });
  assert.equal(await finishSignInFromLink(f.supabase, f.location, f.history), "expired");
  const g = fakes(`${BASE}?token_hash=x&type=email`, { error: { code: "unexpected", message: "Server error" } });
  assert.equal(await finishSignInFromLink(g.supabase, g.location, g.history), "failed");
});

test("no link means nothing to do", async () => {
  const f = fakes(BASE, { error: null });
  assert.equal(await finishSignInFromLink(f.supabase, f.location, f.history), "none");
  assert.equal(f.calls.length, 0);
});
