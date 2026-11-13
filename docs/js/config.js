// config.js - where the website finds Cover's database.
// Both values are public by design: the publishable key only allows what the database's
// safety rules allow (reading live pages, never sponsor emails). Secret keys never go here.

export const SUPABASE_URL = "https://qclasffvdviuugczaway.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_R7OCbhFtdS0-xOAnazuvSw_FdNpYq5r";

// Stripe's publishable key for Cover's platform account (public by design, starts with pk_).
// This is the test-mode key (pk_test_): it only works with Stripe's fake test cards.
export const STRIPE_PUBLISHABLE_KEY = "pk_test_51UbNUDRrexQ0ub4i5S1YrRb0arnzHdY5HoD0Hgpe8XvK2OtWDH7wICjPxoeiWrl7tW8K5eAl1KNZPIrHit3OQdki00O7U46srN";
