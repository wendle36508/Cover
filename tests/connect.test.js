// Tests for supabase/functions/_shared/connect.js (connecting a nonprofit to Stripe). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DASHBOARD_FALLBACK, DASHBOARD_FIRST_CHOICE, EMBEDDED_COMPONENTS, accountRequest, cardPaymentsStatus,
  connectionMessage, readAction, shouldTryFallback,
} from "../supabase/functions/_shared/connect.js";

const nonprofit = { id: "np1", name: "Harbor Paws Rescue" };

test("a new nonprofit account matches the plan: direct charges, Stripe fees and losses", () => {
  const request = accountRequest(nonprofit, "maria@example.org");
  assert.equal(request.display_name, "Harbor Paws Rescue");
  assert.equal(request.contact_email, "maria@example.org");
  assert.equal(request.dashboard, "express");
  assert.deepEqual(request.defaults.responsibilities, { fees_collector: "stripe", losses_collector: "stripe" });
  assert.deepEqual(request.configuration, { merchant: { capabilities: { card_payments: { requested: true } } } });
  assert.equal(request.identity.country, "us");
  assert.ok(!("type" in request), "never uses the old account types");
  assert.ok(!("recipient" in request.configuration), "nonprofits are merchants, not recipients");
});

test("the fallback keeps the same fees and losses, only the dashboard changes", () => {
  const fallback = accountRequest(nonprofit, "m@example.org", DASHBOARD_FALLBACK);
  assert.equal(fallback.dashboard, "full");
  assert.deepEqual(fallback.defaults.responsibilities, accountRequest(nonprofit, "m@example.org", DASHBOARD_FIRST_CHOICE).defaults.responsibilities);
});

test("fall back only when Stripe refuses the setup, not for other errors", () => {
  assert.equal(shouldTryFallback({ error: { code: "account_controller_unsupported_configuration_private_preview" } }), true);
  assert.equal(shouldTryFallback({ error: { code: "invalid", message: "dashboard express is not allowed with losses_collector" } }), true);
  assert.equal(shouldTryFallback({ error: { code: "rate_limit", message: "Too many requests" } }), false);
  assert.equal(shouldTryFallback({ error: { code: "authentication_required", message: "Invalid API key" } }), false);
  assert.equal(shouldTryFallback(undefined), false);
});

test("card payment status is read from the account, with a safe default", () => {
  const account = { configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } } };
  assert.equal(cardPaymentsStatus(account), "active");
  assert.equal(cardPaymentsStatus({}), "not_started");
  assert.equal(cardPaymentsStatus(null), "not_started");
});

test("every Stripe status has a plain-English message", () => {
  for (const status of ["active", "pending", "restricted", "unsupported", "not_started", "something_new"]) {
    const message = connectionMessage(status);
    assert.ok(message.length > 10, status);
  }
  assert.match(connectionMessage("active"), /live/);
});

test("the dashboard gets onboarding, the required notice banner, account, payments and payouts", () => {
  assert.deepEqual(Object.keys(EMBEDDED_COMPONENTS).sort(), ["account_management", "account_onboarding", "notification_banner", "payments", "payouts"]);
  assert.equal(EMBEDDED_COMPONENTS.payments.features.refund_management, true);
});

test("only the two known actions are accepted", () => {
  assert.equal(readAction({ action: "session" }), "session");
  assert.equal(readAction({ action: "status" }), "status");
  for (const bad of [{}, null, { action: "delete_everything" }]) assert.throws(() => readAction(bad), /Unknown action/);
});
