// connect.js - the rules for connecting a nonprofit to Stripe (plain JavaScript, tested with Node).
// Setup chosen in plans/stripe-connect-plan.md: each nonprofit gets its own Stripe account,
// gifts are charged on it directly, Stripe bills the nonprofit its fees and covers losses,
// and the nonprofit manages everything from Cover's dashboard (Stripe's embedded screens).

// Stripe's simple dashboard first. If Stripe refuses that combination for this platform,
// fall back to the full dashboard with the same fee and loss settings (still managed inside Cover).
export const DASHBOARD_FIRST_CHOICE = "express";
export const DASHBOARD_FALLBACK = "full";

/** The Stripe request that creates a nonprofit's account. Stripe's own form collects the rest. */
export function accountRequest(nonprofit, contactEmail, dashboard = DASHBOARD_FIRST_CHOICE) {
  return {
    display_name: nonprofit.name,
    contact_email: contactEmail,
    dashboard,
    identity: { country: "us" },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    defaults: {
      currency: "usd",
      locales: ["en-US"],
      responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
    },
    include: ["configuration.merchant", "requirements"],
  };
}

/**
 * Whose email Stripe uses to reach the nonprofit about its account (payout problems, ID checks): the
 * owner who joined, else the owner who's been invited, else whoever is setting it up. An admin helping a
 * nonprofit (like Cover setting up a pilot) shouldn't end up as the rescue's Stripe contact.
 * @param {{ ownerEmails?: string[], invitedOwnerEmails?: string[], userEmail?: string }} [people]
 * @returns {string}
 */
export function pickContactEmail(people = {}) {
  const { ownerEmails = [], invitedOwnerEmails = [], userEmail = "" } = people;
  const usable = (list) => (Array.isArray(list) ? list : []).find((e) => typeof e === "string" && e.includes("@"));
  return usable(ownerEmails) ?? usable(invitedOwnerEmails) ?? userEmail ?? "";
}

/** True when Stripe refused the dashboard and fee/loss combination, so the fallback is worth trying. */
export function shouldTryFallback(errorBody) {
  const code = errorBody?.error?.code ?? "";
  const message = (errorBody?.error?.message ?? "").toLowerCase();
  return (
    code.includes("unsupported") ||
    code.includes("responsibilit") ||
    code.includes("configuration") ||
    message.includes("dashboard") ||
    message.includes("responsibilit") ||
    message.includes("losses_collector")
  );
}

/**
 * True when Stripe says the saved account doesn't exist for this key. That happens when an account
 * was made in test mode and Cover has since switched to live mode (or the account was deleted).
 * Such an account can never be used, so Cover replaces it with a new one.
 */
export function isMissingAccount(httpStatus, errorBody) {
  const code = errorBody?.error?.code ?? "";
  const message = errorBody?.error?.message ?? "";
  // "...does not have permission to access account acct_..." means the account isn't connected to
  // Cover in this mode. (A key that's missing a permission says "...required permissions for this
  // endpoint" instead, and must NOT count, or real accounts could be dropped.)
  return (
    httpStatus === 404 ||
    code === "resource_missing" ||
    /no such account|exists in test mode|(permission|access) to access account|access to account/i.test(message)
  );
}

/**
 * The same account, asked for the older way (Accounts v1): Stripe covers losses, fees are paid by the
 * nonprofit, Stripe collects the ID details, and the nonprofit gets the small Express dashboard.
 * Used only when Stripe refuses the newer way (see shouldUseV1Fallback).
 */
export function accountRequestV1(nonprofit, contactEmail) {
  return {
    country: "US",
    email: contactEmail || undefined,
    business_profile: { name: nonprofit.name },
    controller: {
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
      stripe_dashboard: { type: "express" },
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { cover_nonprofit_id: nonprofit.id },
  };
}

/** True when Stripe refused the newer way with its "account must be activated" answer. */
export function shouldUseV1Fallback(errorBody) {
  return /must be activated/i.test(errorBody?.error?.message ?? "");
}

/** Status from an older-style (v1) account, in the same words as cardPaymentsStatus. */
export function cardPaymentsStatusV1(account) {
  const capability = account?.capabilities?.card_payments;
  if (capability === "active") return "active";
  if (capability === "pending" || account?.details_submitted) return "pending";
  if (account?.requirements?.disabled_reason) return "restricted";
  return "not_started";
}

/**
 * What a Stripe "account updated" message means for Cover (Nov 25, 2026). Reads the older-style account
 * object Stripe sends with the message. Returns:
 *   live    - the page should take gifts (Stripe can charge cards for this nonprofit)
 *   problem - a plain-English line when Stripe needs something or has paused the account, else null
 *   key     - what exactly Stripe is asking for, so the same problem is emailed only once
 */
export function accountHealth(account) {
  const req = account?.requirements ?? {};
  const live = account?.charges_enabled === true && account?.capabilities?.card_payments === "active";
  const due = [...new Set([...(req.past_due ?? []), ...(req.currently_due ?? [])])].sort();
  const disabled = typeof req.disabled_reason === "string" && req.disabled_reason ? req.disabled_reason : "";
  // Stripe still checking what was sent is normal and needs nothing from anyone, so it isn't a problem.
  const waitingOnStripe = disabled === "requirements.pending_verification" && !due.length;
  if ((!due.length && !disabled) || waitingOnStripe) return { live, problem: null, key: null };
  const paused = account?.charges_enabled !== true || account?.payouts_enabled !== true;
  const problem = paused
    ? "Stripe needs one more thing before gifts and payouts can continue."
    : "Stripe needs one more thing. Gifts still work, but it should be done soon.";
  return { live, problem, key: [disabled, ...due].filter(Boolean).join(",") };
}

/** Where the nonprofit is with Stripe: "active" means they can take payments. */
export function cardPaymentsStatus(account) {
  return account?.configuration?.merchant?.capabilities?.card_payments?.status ?? "not_started";
}

/** A short, plain-English line for the dashboard about payouts. Never mentions Stripe: nonprofits only see Cover. */
export function connectionMessage(status) {
  switch (status) {
    case "active":
      return "You're approved. Your page is live and taking sponsors.";
    case "pending":
      return "We're verifying your details. This usually takes a few minutes, sometimes a day or two.";
    case "restricted":
      return "We need a bit more information before you can take payments.";
    case "unsupported":
      return "Payments can't be turned on for this account. Contact Cover for help.";
    default:
      return "Set up payouts so sponsors can pay you.";
  }
}

/** The Stripe screens a nonprofit can use inside Cover's dashboard. */
export const EMBEDDED_COMPONENTS = {
  account_onboarding: { enabled: true },
  notification_banner: { enabled: true },
  account_management: { enabled: true },
  payments: { enabled: true, features: { refund_management: true, dispute_management: true } },
  payouts: { enabled: true },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read { action } from the dashboard's request. */
export function readAction(body) {
  const action = body?.action;
  if (action !== "session" && action !== "status") throw new Error("Unknown action.");
  return action;
}

/** Which nonprofit the request is about (people who help run several send its id), or null. */
export function readNonprofitId(body) {
  const id = body?.nonprofitId;
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error("Unknown action.");
  return id;
}
