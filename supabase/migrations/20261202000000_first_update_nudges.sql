-- The sponsorship program, part 1 (approved by Tanner, Nov 25, 2026).
-- The welcome pack tells new sponsors to expect a first photo in the first week. If a new sponsor has
-- had nothing after 5 days, Cover's daily job reminds the nonprofit's owners, once per sponsor.
-- This table remembers who the owners were already reminded about. Only Cover's server uses it.

create table public.first_update_nudges (
  sponsor_id uuid primary key references public.sponsors (id) on delete cascade,
  nonprofit_id uuid not null references public.nonprofits (id) on delete cascade,
  sent_at timestamptz not null default now()
);
comment on table public.first_update_nudges is 'New sponsors whose first photo the owners were reminded about (once each). Server only.';
alter table public.first_update_nudges enable row level security;
revoke all on public.first_update_nudges from anon, authenticated;
