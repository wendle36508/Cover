// seed-demo.mjs - writes the SQL that loads one of the demo nonprofits (orgs.js) into Cover's
// database as a real, live test page connected to a Stripe test account.
//
// Usage:
//   node scripts/seed-demo.mjs <demo: rescue|pantry|youth> <page-link> <acct_...>  > supabase/seed-test.sql
// Then run the file against the database (asks before changing anything):
//   npx supabase db query --remote --file supabase/seed-test.sql
//
// Running it again for the same page link replaces that page's content and things to follow.

import { ORGS } from "../docs/js/orgs.js";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/;
const PAGE_FIELDS = [
  "initials", "eyebrow", "headline", "lead", "heroPhotoWide", "heroAlt", "navLabel", "cta", "browse", "trust",
  "listEyebrow", "listTitle", "listLead", "filters", "steps", "quote", "quotePhoto", "faq", "everyone",
];

/** A SQL text literal: wrapped in single quotes with any quotes inside doubled, so text can't break out. */
export function sqlText(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The SQL for one demo nonprofit. Throws a clear error for bad input. */
export function seedSql(demoKey, slug, stripeAccountId) {
  const org = ORGS[demoKey];
  if (!org) throw new Error(`Unknown demo "${demoKey}". Use one of: ${Object.keys(ORGS).join(", ")}.`);
  if (!SLUG_PATTERN.test(slug ?? "")) throw new Error("The page link must be lowercase words joined by dashes, like harbor-paws.");
  if (!ACCOUNT_PATTERN.test(stripeAccountId ?? "")) throw new Error("The Stripe account id must look like acct_123abc.");

  const page = Object.fromEntries(PAGE_FIELDS.filter((field) => org[field] !== undefined).map((field) => [field, org[field]]));
  const photo = (name) => `photos/${name}.jpg`;
  page.heroPhotoWide = photo(org.heroPhotoWide);
  page.quotePhoto = photo(org.quotePhoto);

  const items = org.items.map((item, index) =>
    `  ((select id from np), ${sqlText(item.name)}, ${sqlText(photo(item.photo))}, ${sqlText(item.badge)}, ${sqlText(item.note)}, ${index})`,
  );
  return `-- Test page for ${org.name} (made-up demo content), connected to Stripe test account ${stripeAccountId}.
begin;
insert into public.nonprofits (slug, name, place, kind, monthly_price_cents, monthly_goal_cents, page, stripe_account_id, is_live)
values (${sqlText(slug)}, ${sqlText(org.name)}, ${sqlText(org.place)}, ${sqlText(org.kind)}, ${org.price * 100}, ${org.goal * 100},
        ${sqlText(JSON.stringify(page))}::jsonb, ${sqlText(stripeAccountId)}, true)
on conflict (slug) do update set
  name = excluded.name, place = excluded.place, kind = excluded.kind,
  monthly_price_cents = excluded.monthly_price_cents, monthly_goal_cents = excluded.monthly_goal_cents,
  page = excluded.page, stripe_account_id = excluded.stripe_account_id, is_live = excluded.is_live;

with np as (select id from public.nonprofits where slug = ${sqlText(slug)})
delete from public.follow_items where nonprofit_id = (select id from np)
  and not exists (select 1 from public.sponsors s where s.item_id = follow_items.id);

with np as (select id from public.nonprofits where slug = ${sqlText(slug)})
insert into public.follow_items (nonprofit_id, name, photo_url, badge, note, sort_order) values
${items.join(",\n")}
on conflict (nonprofit_id, name) do update set
  photo_url = excluded.photo_url, badge = excluded.badge, note = excluded.note, sort_order = excluded.sort_order, status = 'active';
commit;
`;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")}`) {
  const [demoKey, slug, account] = process.argv.slice(2);
  try {
    process.stdout.write(seedSql(demoKey, slug, account));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
