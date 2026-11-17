-- Cover insights (Tanner, Nov 17 2026: "put it in its own database inside cover").
-- Public nonprofit and giving data, kept in its own walled-off "insights" schema, apart from live
-- sponsor and payment data. Public records and totals only: no donor names, no officer names, no
-- street addresses. Sources: IRS EO Business Master File, Pub 78, auto-revocation list, 990-N.
--
-- Who can reach it:
--   * Nobody through the website's public API: the schema isn't exposed and anon/authenticated
--     have no rights on its tables.
--   * Cover admins (Tanner), through the admin-only functions at the bottom (Cover HQ).
--   * The monthly importer (a GitHub Actions job), through insights_import_* functions that need
--     the import secret. The database keeps only a SHA-256 hash of that secret.

create schema if not exists insights;
revoke all on schema insights from public, anon, authenticated;

-- ---------- Tables ----------

-- Every US 501(c)(3) public charity in the IRS registry, except churches (foundation code 10).
create table insights.orgs (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  name text not null,
  city text,
  state text,
  zip5 text,
  ntee text,                -- cause code, like D20 (animal protection)
  foundation text,          -- IRS foundation code (15/16/17 = publicly supported, etc.)
  ruling_year integer,      -- year the IRS recognized the exemption
  revenue bigint,           -- latest revenue the IRS has on file (dollars)
  assets bigint,
  income bigint,
  tax_period text,          -- YYYYMM of the return those amounts came from
  pub78_codes text,         -- deductibility codes from Pub 78; null = not listed
  pub78_seen_at timestamptz,
  last_990n_year integer,   -- latest year it filed the 990-N postcard (tiny orgs)
  seen_at timestamptz not null default now()  -- last import that saw it (old rows get removed)
);
comment on table insights.orgs is 'IRS registry of US 501(c)(3) public charities (no churches). Public records only.';
create index orgs_state_ntee_idx on insights.orgs (state, ntee);
create index orgs_zip_idx on insights.orgs (zip5);
create index orgs_revenue_idx on insights.orgs (revenue);
create index orgs_seen_idx on insights.orgs (seen_at);
create index orgs_pub78_seen_idx on insights.orgs (pub78_seen_at) where pub78_codes is not null;

-- 501(c)(3)s the IRS revoked for not filing 3 years in a row (they drop out of the registry).
create table insights.revocations (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  revoked_on date,
  reinstated_on date,
  seen_at timestamptz not null default now()
);
create index revocations_seen_idx on insights.revocations (seen_at);
comment on table insights.revocations is 'IRS auto-revocation list, 501(c)(3)s only.';

-- One row per data source: when it last imported, from which file date, how many rows.
create table insights.imports (
  source text primary key,
  file_date date,
  rows_loaded integer not null default 0,
  rows_before integer not null default 0,  -- rows stored when the run started (safety check for cleanup)
  started_at timestamptz,
  finished_at timestamptz,
  status text not null default 'never' check (status in ('never', 'running', 'done', 'failed')),
  note text
);

-- Hand-kept headline numbers from donor-behavior reports (FEP, M+R, Blackbaud...). Cited, not scraped.
create table insights.benchmarks (
  id text primary key check (id ~ '^[a-z0-9_]{3,60}$'),
  label text not null,
  value text not null,
  definition text not null,
  source_name text not null,
  source_url text not null check (source_url ~ '^https://'),
  as_of date not null,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

-- The importer's key, stored only as a SHA-256 hash.
create table insights.import_keys (hash text primary key check (hash ~ '^[0-9a-f]{64}$'));

alter table insights.orgs enable row level security;
alter table insights.revocations enable row level security;
alter table insights.imports enable row level security;
alter table insights.benchmarks enable row level security;
alter table insights.import_keys enable row level security;
revoke all on all tables in schema insights from public, anon, authenticated;

insert into insights.imports (source) values ('irs_bmf'), ('irs_pub78'), ('irs_revocations'), ('irs_990n');

-- ---------- Importer functions (need the import secret) ----------

create function insights.check_key(secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if secret is null or length(secret) < 32 or not exists (
    select 1 from insights.import_keys k where k.hash = encode(sha256(convert_to(secret, 'UTF8')), 'hex')
  ) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
end;
$$;

-- Start a run: marks the source running and returns the run's start time (used to drop stale rows).
create function public.insights_import_start(secret text, source_name text, file_day date)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  started timestamptz := clock_timestamp();
begin
  perform insights.check_key(secret);
  update insights.imports set status = 'running', started_at = started, file_date = file_day, rows_loaded = 0, note = null,
    rows_before = case source_name
      when 'irs_bmf' then (select count(*) from insights.orgs)
      when 'irs_revocations' then (select count(*) from insights.revocations)
      when 'irs_pub78' then (select count(*) from insights.orgs where pub78_codes is not null)
      else 0 end
  where source = source_name;
  if not found then raise exception 'Unknown source.' using errcode = '22023'; end if;
  return started;
end;
$$;

-- Registry rows, as arrays: [ein, name, city, state, zip5, ntee, foundation, ruling_year, revenue, assets, income, tax_period]
create function public.insights_import_orgs(secret text, batch jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  loaded integer;
begin
  perform insights.check_key(secret);
  insert into insights.orgs as o (ein, name, city, state, zip5, ntee, foundation, ruling_year, revenue, assets, income, tax_period, seen_at)
  select r->>0, r->>1, r->>2, r->>3, r->>4, r->>5, r->>6, (r->>7)::integer, (r->>8)::bigint, (r->>9)::bigint, (r->>10)::bigint, r->>11, now()
  from jsonb_array_elements(batch) r
  on conflict (ein) do update set
    name = excluded.name, city = excluded.city, state = excluded.state, zip5 = excluded.zip5, ntee = excluded.ntee,
    foundation = excluded.foundation, ruling_year = excluded.ruling_year, revenue = excluded.revenue,
    assets = excluded.assets, income = excluded.income, tax_period = excluded.tax_period, seen_at = excluded.seen_at;
  get diagnostics loaded = row_count;
  update insights.imports set rows_loaded = rows_loaded + loaded where source = 'irs_bmf';
  return loaded;
end;
$$;

-- Pub 78 rows: [ein, codes]. Only updates orgs already in the registry.
create function public.insights_import_pub78(secret text, batch jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  loaded integer;
begin
  perform insights.check_key(secret);
  update insights.orgs o set pub78_codes = r->>1, pub78_seen_at = now()
  from jsonb_array_elements(batch) r
  where o.ein = r->>0;
  get diagnostics loaded = row_count;
  update insights.imports set rows_loaded = rows_loaded + loaded where source = 'irs_pub78';
  return loaded;
end;
$$;

-- 990-N rows: [ein, latest_tax_year]. Only updates orgs already in the registry.
create function public.insights_import_990n(secret text, batch jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  loaded integer;
begin
  perform insights.check_key(secret);
  update insights.orgs o set last_990n_year = (r->>1)::integer
  from jsonb_array_elements(batch) r
  where o.ein = r->>0;
  get diagnostics loaded = row_count;
  update insights.imports set rows_loaded = rows_loaded + loaded where source = 'irs_990n';
  return loaded;
end;
$$;

-- Revocation rows: [ein, revoked_on, reinstated_on] (dates as YYYY-MM-DD or null).
create function public.insights_import_revocations(secret text, batch jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  loaded integer;
begin
  perform insights.check_key(secret);
  insert into insights.revocations as v (ein, revoked_on, reinstated_on, seen_at)
  select r->>0, (r->>1)::date, (r->>2)::date, now() from jsonb_array_elements(batch) r
  on conflict (ein) do update set revoked_on = excluded.revoked_on, reinstated_on = excluded.reinstated_on, seen_at = excluded.seen_at;
  get diagnostics loaded = row_count;
  update insights.imports set rows_loaded = rows_loaded + loaded where source = 'irs_revocations';
  return loaded;
end;
$$;

-- After a successful run: remove what the new file no longer has, 5,000 rows per call (the importer
-- calls until it returns 0; Supabase stops any single request after a few seconds). Registry and
-- revocation rows not seen this run are deleted; Pub 78 codes not seen this run are cleared.
-- Safety: nothing is removed unless this run loaded at least 90% as many rows as were stored before,
-- so a half-failed run never wipes good data.
create function public.insights_import_cleanup(secret text, source_name text, run_started timestamptz)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  run insights.imports;
  removed integer := 0;
begin
  perform insights.check_key(secret);
  select * into run from insights.imports where source = source_name;
  if run.source is null then raise exception 'Unknown source.' using errcode = '22023'; end if;
  if run.rows_loaded < run.rows_before * 0.9 then return 0; end if;
  if source_name = 'irs_bmf' then
    delete from insights.orgs where ctid in (select ctid from insights.orgs where seen_at < run_started limit 5000);
  elsif source_name = 'irs_revocations' then
    delete from insights.revocations where ctid in (select ctid from insights.revocations where seen_at < run_started limit 5000);
  elsif source_name = 'irs_pub78' then
    update insights.orgs set pub78_codes = null
    where ctid in (select ctid from insights.orgs where pub78_codes is not null and pub78_seen_at < run_started limit 5000);
  end if;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Mark a run done or failed, with a short note.
create function public.insights_import_finish(secret text, source_name text, ok boolean, run_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform insights.check_key(secret);
  update insights.imports
  set status = case when ok then 'done' else 'failed' end, finished_at = clock_timestamp(), note = left(run_note, 300)
  where source = source_name;
  if not found then raise exception 'Unknown source.' using errcode = '22023'; end if;
end;
$$;

revoke execute on function insights.check_key(text) from public, anon, authenticated;
revoke execute on function public.insights_import_start(text, text, date) from public;
revoke execute on function public.insights_import_orgs(text, jsonb) from public;
revoke execute on function public.insights_import_pub78(text, jsonb) from public;
revoke execute on function public.insights_import_990n(text, jsonb) from public;
revoke execute on function public.insights_import_revocations(text, jsonb) from public;
revoke execute on function public.insights_import_cleanup(text, text, timestamptz) from public;
revoke execute on function public.insights_import_finish(text, text, boolean, text) from public;
-- The importer calls with the site's public key (anon) plus the secret; the secret is the real lock.
grant execute on function public.insights_import_start(text, text, date) to anon;
grant execute on function public.insights_import_orgs(text, jsonb) to anon;
grant execute on function public.insights_import_pub78(text, jsonb) to anon;
grant execute on function public.insights_import_990n(text, jsonb) to anon;
grant execute on function public.insights_import_revocations(text, jsonb) to anon;
grant execute on function public.insights_import_cleanup(text, text, timestamptz) to anon;
grant execute on function public.insights_import_finish(text, text, boolean, text) to anon;

-- ---------- Cover HQ (admins only) ----------

-- Each source's last run plus table sizes.
create function public.admin_insights_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can see this.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'sources', (select coalesce(jsonb_agg(to_jsonb(i) order by i.source), '[]'::jsonb) from insights.imports i),
    'orgs', (select count(*) from insights.orgs),
    'prospects', (select count(*) from insights.orgs where revenue between 50000 and 10000000),
    'revocations', (select count(*) from insights.revocations where reinstated_on is null),
    'benchmarks', (select coalesce(jsonb_agg(to_jsonb(b) order by b.sort_order, b.id), '[]'::jsonb) from insights.benchmarks b)
  );
end;
$$;

-- Add or change one benchmark number (HQ edit form).
create function public.admin_save_benchmark(item jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can do that.' using errcode = '42501';
  end if;
  insert into insights.benchmarks (id, label, value, definition, source_name, source_url, as_of, sort_order, updated_at)
  values (item->>'id', btrim(item->>'label'), btrim(item->>'value'), btrim(item->>'definition'), btrim(item->>'source_name'),
          btrim(item->>'source_url'), (item->>'as_of')::date, coalesce((item->>'sort_order')::integer, 0), now())
  on conflict (id) do update set label = excluded.label, value = excluded.value, definition = excluded.definition,
    source_name = excluded.source_name, source_url = excluded.source_url, as_of = excluded.as_of,
    sort_order = excluded.sort_order, updated_at = now();
end;
$$;

-- Good-standing check for one EIN: is it a 501(c)(3) in good standing? Public IRS facts only.
create function public.admin_check_ein(target_ein text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  clean text := regexp_replace(coalesce(target_ein, ''), '[^0-9]', '', 'g');
  org insights.orgs;
  rev insights.revocations;
begin
  if not private.is_cover_admin() then
    raise exception 'Only Cover admins can do that.' using errcode = '42501';
  end if;
  if clean !~ '^[0-9]{9}$' then
    return jsonb_build_object('status', 'bad_ein');
  end if;
  select * into org from insights.orgs where ein = clean;
  select * into rev from insights.revocations where ein = clean;
  return jsonb_build_object(
    'ein', clean,
    'status', case
      when rev.ein is not null and rev.reinstated_on is null then 'revoked'
      when org.ein is null then 'not_found'
      when org.pub78_codes is null then 'not_in_pub78'
      else 'good' end,
    'name', org.name, 'city', org.city, 'state', org.state, 'ntee', org.ntee,
    'revenue', org.revenue, 'tax_period', org.tax_period, 'last_990n_year', org.last_990n_year,
    'revoked_on', rev.revoked_on, 'reinstated_on', rev.reinstated_on
  );
end;
$$;

revoke execute on function public.admin_insights_status() from public, anon;
revoke execute on function public.admin_save_benchmark(jsonb) from public, anon;
revoke execute on function public.admin_check_ein(text) from public, anon;
grant execute on function public.admin_insights_status() to authenticated;
grant execute on function public.admin_save_benchmark(jsonb) to authenticated;
grant execute on function public.admin_check_ein(text) to authenticated;

-- ---------- Starting benchmark numbers (from company/reports/Donor and funding data sources.md) ----------

insert into insights.benchmarks (id, label, value, definition, source_name, source_url, as_of, sort_order) values
  ('fep_retention_ytd', 'Donor retention (year to date)', '26.4%', 'Share of last year''s donors who gave again so far this year. Cumulative through Q2, so not comparable to 12-month figures.', 'Fundraising Effectiveness Project, Q2 2026', 'https://publications.fepreports.org/', '2026-10-29', 10),
  ('fep_frequent_retention', 'Retention: donors who gave 7+ times', '90% vs 14.4% for one-time donors', 'Retention of donors who gave 7 or more times last year, compared with donors who gave once.', 'Fundraising Effectiveness Project, Q2 2026', 'https://www.pr.com/press-release/983077', '2026-10-29', 20),
  ('fep_dollars_donors', 'Dollars vs donors (year to date)', 'Dollars +6.6%, donors -1.6%', 'Change in total dollars and in number of donors compared with the same period last year.', 'Fundraising Effectiveness Project, Q2 2026', 'https://www.pr.com/press-release/983077', '2026-10-29', 30),
  ('fep_micro_donors', 'Micro donors ($1 to $100)', '51.6% of donors; count -4.2%', 'Share of all donors giving $1 to $100 a year, and the change in their number.', 'Fundraising Effectiveness Project, Q2 2026', 'https://www.pr.com/press-release/983077', '2026-10-29', 40),
  ('mr_monthly_share', 'Monthly giving share of online revenue', '27% (22% small orgs, 37% orgs over $10M)', 'Monthly gifts as a share of online revenue in 2025. "Small" means under $1M in online revenue.', 'M+R Benchmarks 2026', 'https://mrbenchmarks.com/fundraising/', '2026-01-01', 50),
  ('mr_monthly_retention', 'Monthly donor retention', '71% after 12 months; 10% quit within 2 months', 'Share of new monthly donors still giving after 12 months, and share who stop in the first two months.', 'M+R Benchmarks 2026', 'https://mrbenchmarks.com/fundraising/', '2026-01-01', 60),
  ('mr_december', 'December share of online revenue', '37%', 'Share of a year''s online revenue that arrives in December.', 'M+R Benchmarks 2026', 'https://mrbenchmarks.com/fundraising/', '2026-01-01', 70),
  ('bb_size_split', 'Revenue growth by org size', 'Small orgs -6.4%, large orgs +11.7%', 'Year-over-year revenue change by organization size.', 'Blackbaud Institute, 2025 Trends in Giving', 'https://institute.blackbaud.com/2025-trends-in-giving/', '2025-01-01', 80),
  ('bb_q4_share', 'Q4 share of revenue', '36.1%', 'Share of yearly revenue that arrives October to December.', 'Blackbaud Institute, 2025 Trends in Giving', 'https://institute.blackbaud.com/2025-trends-in-giving/', '2025-01-01', 90),
  ('bb_new_recurring', 'New donors who start as recurring', 'Under 2%', 'Share of first-time donors whose first gift is a recurring gift.', 'GivingTuesday and Blackbaud special report', 'https://institute.blackbaud.com/resources/givingtuesday-special-report', '2025-01-01', 100),
  ('neon_recurring_retention', 'Recurring vs other donor retention', '79.1% vs 32.4%', 'Retention of recurring donors compared with everyone else, across 4,107 organizations.', 'Neon One Recurring Donor Report', 'https://neonone.com/resources/blog/recurring-donors/', '2025-01-01', 110),
  ('neon_first_gift', 'Median first recurring gift', '$30', 'Median amount of a donor''s first recurring gift.', 'Neon One Recurring Donor Report', 'https://neonone.com/resources/blog/recurring-donors/', '2025-01-01', 120),
  ('giving_usa_total', 'Total US giving, 2025', '$617.2B (+5.7%; +3.0% after inflation)', 'All charitable giving in the US in 2025.', 'Giving USA 2026 (via Lilly Family School)', 'https://philanthropy.indianapolis.iu.edu/news-events/news/_news/2026/giving-usa-report-2026.html', '2026-06-23', 130),
  ('giving_usa_individuals', 'Individuals'' share of US giving', '64% (80% in 1985)', 'Share of all US giving that comes from individuals rather than foundations, bequests or companies.', 'Giving USA 2026 (via AP)', 'https://ny1.com/nyc/all-boroughs/ap-top-news/2026/06/23/donors-gave-us-charities-617-billion-in-2025-according-to-giving-usa-report', '2026-06-23', 140),
  ('bls_household_gifts', 'Average household cash contributions', '$2,237 in 2025 (-2.4%)', 'Average yearly cash contributions per household. May include gifts to people outside the household and to religious groups.', 'BLS Consumer Expenditure Survey', 'https://www.bls.gov/news.release/cesan.htm', '2026-10-29', 150);
