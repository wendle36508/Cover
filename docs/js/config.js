// config.js - where the website finds Cover's database.
// Both values are public by design: the publishable key only allows what the database's
// safety rules allow (reading live pages, never sponsor emails). Secret keys never go here.

export const SUPABASE_URL = "https://qclasffvdviuugczaway.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_R7OCbhFtdS0-xOAnazuvSw_FdNpYq5r";

// Stripe's publishable key for Cover's platform account (public by design, starts with pk_).
// Live key (pk_live_): real cards, real money. Public by design.
export const STRIPE_PUBLISHABLE_KEY = "pk_live_51UbSDHRvu4bccotRTb9scZjiBnowDMpJJf4dUrl0EQBgdG0Q0Sd4ZhvKJM21lQDCcQQkqC3XOcMyceI4UdjZw0oU007hEUMNrI";
