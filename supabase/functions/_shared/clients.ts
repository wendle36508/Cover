// clients.ts - Stripe and database connections for Cover's server functions (Supabase Edge Functions, Deno).
// Secrets come from Supabase's private settings (Project Settings -> Edge Functions -> Secrets),
// never from the code or the website.

import Stripe from "npm:stripe@23";
import { createClient } from "npm:@supabase/supabase-js@2";

// Stripe's current API version (checked Nov 13, 2026). Payments use the stable version.
export const STRIPE_API_VERSION = "2026-10-28.endive";

export function requireSetting(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing setting ${name}. Add it in Supabase: Edge Functions -> Secrets.`);
  return value;
}

/**
 * Cover's Stripe key. Uses the restricted key (STRIPE_RESTRICTED_KEY, only the permissions Cover needs)
 * when it's set, otherwise the full secret key. To undo a bad restricted key instantly, delete that one
 * secret in Supabase and Cover goes back to STRIPE_SECRET_KEY.
 */
export function stripeKey(): string {
  return Deno.env.get("STRIPE_RESTRICTED_KEY") || requireSetting("STRIPE_SECRET_KEY");
}

export function stripeClient(): Stripe {
  return new Stripe(stripeKey(), {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: "Cover" },
  });
}

/** Database connection with full access. Server-only: never send this key to a browser. */
export function adminDatabase() {
  return createClient(requireSetting("SUPABASE_URL"), requireSetting("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
