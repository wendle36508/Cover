-- Sign in on your computer by opening the email on your phone (Tanner, Nov 25, 2026).
-- When someone asks for a My sponsorships link, their computer keeps a secret and shows a 4-digit
-- number. The email's link names this waiting sign-in. Opening it on a phone asks "Does your computer
-- show 4821?"; a yes signs that computer in by itself. Without the yes nothing happens, so a stranger
-- who types someone's email on their own computer can't be signed in by a careless tap.
-- Only Cover's server reads this table. Rows last 15 minutes and are cleaned up after a day.

create table public.sign_in_waits (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 of the computer's secret, never the secret
  code text not null check (code ~ '^[0-9]{4}$'),                    -- the number both screens show
  created_at timestamptz not null default now(),
  approved_at timestamptz,                                          -- the phone said yes
  used_at timestamptz                                               -- the computer picked up its sign-in
);
comment on table public.sign_in_waits is 'A My sponsorships sign-in waiting for a yes from the emailed link (15 minutes). Server only.';
create index sign_in_waits_created_idx on public.sign_in_waits (created_at);
alter table public.sign_in_waits enable row level security;
revoke all on public.sign_in_waits from anon, authenticated;
