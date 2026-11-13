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

/** Read { action } from the dashboard's request. */
export function readAction(body) {
  const action = body?.action;
  if (action !== "session" && action !== "status") throw new Error("Unknown action.");
  return action;
}
