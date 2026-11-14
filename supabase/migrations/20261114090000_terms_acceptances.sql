-- Terms of Service agreements (Tanner, Nov 14): people check "I agree" above the sign-in button.
-- This keeps a record of who agreed to which version and when, so Cover can show it if ever asked.

create table public.terms_acceptances (
  user_id uuid not null references auth.users (id) on delete cascade,
  version text not null check (version ~ '^\d{4}-\d{2}-\d{2}$'),
  email text,
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);
comment on table public.terms_acceptances is 'Who agreed to which Terms of Service version, and when.';

alter table public.terms_acceptances enable row level security;
create policy "People see their own agreements" on public.terms_acceptances
  for select to authenticated using (user_id = (select auth.uid()) or private.is_cover_admin());
revoke insert, update, delete on public.terms_acceptances from anon, authenticated;
revoke all on public.terms_acceptances from anon;

-- Record that the signed-in person agreed to a version. Running it again changes nothing.
create function public.record_terms_acceptance(accepted_version text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if accepted_version !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Unknown terms version.' using errcode = '22023';
  end if;
  insert into public.terms_acceptances (user_id, version, email)
  values ((select auth.uid()), accepted_version, (select u.email from auth.users u where u.id = (select auth.uid())))
  on conflict (user_id, version) do nothing;
end;
$$;
revoke execute on function public.record_terms_acceptance(text) from public, anon;
grant execute on function public.record_terms_acceptance(text) to authenticated;
