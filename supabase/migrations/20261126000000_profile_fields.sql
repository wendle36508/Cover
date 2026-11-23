-- New sponsor pages, phase 1 (Dogs Trust-style model, approved by Tanner Nov 22, 2026).
-- Each dog or program can now have:
--   facts     a few short facts the nonprofit chooses ({"Age": "1½ years", "Breed": "Terrier mix"})
--             shown as chips on its card and profile, and used for the browse list's filters
--   is_group  a group sponsorship ("Golden Oldies", "Saturday Breakfast Crew") instead of one individual
--   why       "Why I need sponsoring" on the profile page
--   loves / dislikes   the optional "I love / I'm not a fan of" lines
-- Nonprofit-wide content (their numbers, "your gift helps with", happy endings, questions, template)
-- lives in nonprofits.page like the rest of their page settings, so it needs no new columns.
-- All optional: a dog with just a photo and a name still works. Same safety rules as before:
-- anyone can read them on live pages, only the nonprofit's staff can change them.

create or replace function private.facts_ok(facts jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(facts) = 'object'
    and (select count(*) from jsonb_object_keys(facts)) <= 8
    and coalesce((
      select bool_and(char_length(f.key) between 1 and 30 and jsonb_typeof(f.value) = 'string' and char_length(f.value #>> '{}') <= 40)
      from jsonb_each(facts) as f
    ), true);
$$;

alter table public.follow_items
  add column facts jsonb not null default '{}'::jsonb check (private.facts_ok(facts)),
  add column is_group boolean not null default false,
  add column why text check (char_length(why) <= 600),
  add column loves text check (char_length(loves) <= 120),
  add column dislikes text check (char_length(dislikes) <= 120);

comment on column public.follow_items.facts is 'Up to 8 short facts shown as chips, like {"Age": "1½ years"} (keys up to 30, values up to 40 characters).';
comment on column public.follow_items.is_group is 'A group sponsorship (several animals or a program) instead of one individual.';
comment on column public.follow_items.why is 'Why they need sponsoring (profile page, up to 600 characters).';
comment on column public.follow_items.loves is 'Optional "I love" line on the profile page.';
comment on column public.follow_items.dislikes is 'Optional "I''m not a fan of" line on the profile page.';
