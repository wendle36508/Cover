-- A log of every Stripe message (webhook event) Cover receives, after its signature is verified.
-- Uses: skip duplicates (Stripe can send the same event twice), and keep a record of disputes,
-- refunds and fraud warnings so someone can review them. Only Cover's server can read or write it.

create table public.stripe_events (
  id text primary key,                 -- Stripe's event id (evt_...)
  type text not null,
  account text,                        -- the nonprofit's connected account, for Connect events
  needs_review boolean not null default false,
  received_at timestamptz not null default now()
);
comment on table public.stripe_events is 'Verified Stripe webhook events. Private to Cover''s server.';
create index stripe_events_review_idx on public.stripe_events (needs_review) where needs_review;

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;
