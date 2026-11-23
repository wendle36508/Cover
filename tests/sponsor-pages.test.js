// Tests for the new sponsor pages (phase 1): templates per nonprofit type, which page a link opens,
// fact chips, the browse list's filters and sorting, profile wording, and the new fields from the
// database. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { ICON_LABELS, ICON_NAMES, iconSvg } from "../docs/js/icons.js";
import { orgFromRows } from "../docs/js/live.js";
import { browseList, factChips, filterOptions, profileHeading, profileLabels, readView, viewLink } from "../docs/js/sponsor-page-logic.js";
import { faqList, pageSettings, receiveList, TEMPLATES, templateKey } from "../docs/js/templates.js";

const dog = (name, facts = {}, extra = {}) => ({ name, facts, isGroup: false, addedAt: "2026-11-10T00:00:00Z", ...extra });
const DOGS = [
  dog("Burt", { Age: "1½ years", Breed: "Terrier mix", Sex: "Male" }, { addedAt: "2026-11-12T00:00:00Z" }),
  dog("Fiona", { Age: "9 years", Sex: "Female" }, { addedAt: "2026-11-01T00:00:00Z" }),
  dog("Becky", { Age: "11 years", Breed: "Lab mix", Sex: "Female" }, { addedAt: "2026-11-05T00:00:00Z" }),
  dog("Dunkin", { Age: "18 months", Breed: "Shepherd mix", Sex: "Male" }, { addedAt: "2026-11-20T00:00:00Z" }),
  dog("Golden Oldies", {}, { isGroup: true, addedAt: "2026-10-01T00:00:00Z" }),
];
const RESCUE = pageSettings({ kind: "animal", navLabel: "Dogs" });

test("each nonprofit gets a template, and the owner's settings win over it", () => {
  assert.equal(templateKey({ kind: "animal" }), "rescue");
  assert.equal(templateKey({ kind: "program" }), "food");
  assert.equal(templateKey({ kind: "program", template: "youth" }), "youth");
  assert.equal(templateKey({ kind: "animal", template: "made-up" }), "rescue");
  assert.deepEqual([RESCUE.one, RESCUE.firstPerson, RESCUE.factFields], ["dog", true, ["Age", "Breed", "Sex"]]);
  const youth = pageSettings({ kind: "program", template: "youth" });
  assert.deepEqual([youth.follow, youth.one, youth.firstPerson, youth.groupsDefault], ["Teams", "team", false, true]);
  assert.equal(pageSettings({ template: "health" }).groupsDefault, true, "hospitals default to groups");
  const custom = pageSettings({ kind: "animal", navLabel: "Cats", firstPerson: false, factFields: ["Age", "Color"], helps: [{ title: "Litter", text: "Lots of it" }] });
  assert.deepEqual([custom.follow, custom.one, custom.firstPerson, custom.factFields], ["Cats", "cat", false, ["Age", "Color"]]);
  assert.deepEqual(custom.helps, [{ icon: "heart", title: "Litter", text: "Lots of it" }]);
  for (const key of Object.keys(TEMPLATES)) assert.equal(TEMPLATES[key].helps.length, 4, key);
});

test("bad page settings are dropped, never shown", () => {
  const s = pageSettings({
    kind: "animal",
    stats: [{ value: "2,000+", label: "dogs placed" }, { value: "", label: "x" }, { value: "a".repeat(30), label: "too long" }, null, "text"],
    stories: [{ title: "Bella went home", text: "She did!" }, { title: "No text" }],
    faq: [{ q: "Can I visit?", a: "Yes, on Saturdays." }, { q: "Only a question" }],
    factFields: "not a list",
    helps: [{ title: "" }],
  });
  assert.deepEqual(s.stats, [{ value: "2,000+", label: "dogs placed" }]);
  assert.deepEqual(s.stories.map((x) => x.title), ["Bella went home"]);
  assert.deepEqual(s.extraFaq.map((x) => x.q), ["Can I visit?"]);
  assert.deepEqual(s.factFields, ["Age", "Breed", "Sex"], "falls back to the template");
  assert.equal(s.helps.length, 4, "falls back to the template");
});

test("what sponsors receive says only what Cover really does", () => {
  assert.deepEqual(receiveList(RESCUE, "Burt"), ["A photo certificate to keep or print", "Photo updates and news about Burt", "A note if Burt is adopted, and the chance to pick someone new", "Change or cancel anytime, online"]);
  assert.match(receiveList(pageSettings({ kind: "program" }))[2], /your program wraps up/);
});

test("the questions are true for every Cover nonprofit, and mention the fee only when it's on", () => {
  const off = faqList(RESCUE, "Lucky Pup Rescue");
  assert.deepEqual(off.map((x) => x.q), ["Am I the only sponsor?", "What happens if my dog is adopted?", "Where does my money go?", "Can I change or cancel?"]);
  assert.doesNotMatch(off[2].a, /3%/);
  assert.match(faqList(RESCUE, "Lucky Pup Rescue", true)[2].a, /Cover keeps 3% of each gift/);
  const withOwn = faqList(pageSettings({ kind: "animal", faq: [{ q: "Can I visit?", a: "Yes." }] }), "X");
  assert.equal(withOwn.at(-1).q, "Can I visit?", "the owner's questions come after Cover's");
});

test("a link opens the right page", () => {
  assert.deepEqual(readView("?org=lucky", DOGS), { page: "home", item: null });
  assert.deepEqual(readView("?org=lucky&view=all", DOGS), { page: "browse", item: null });
  assert.equal(readView("?org=lucky&dog=golden-oldies", DOGS).item.name, "Golden Oldies");
  assert.deepEqual(readView("?org=lucky&dog=nobody", DOGS), { page: "home", item: null }, "unknown dog: the home page");
  assert.equal(viewLink("lucky", "home"), "sponsor.html?org=lucky");
  assert.equal(viewLink("lucky", "browse"), "sponsor.html?org=lucky&view=all");
  assert.equal(viewLink("lucky", "profile", { name: "Golden Oldies" }), "sponsor.html?org=lucky&dog=golden-oldies");
});

test("fact chips follow the nonprofit's order and skip blanks", () => {
  assert.deepEqual(factChips(DOGS[0], ["Sex", "Age"]), [{ field: "Sex", value: "Male" }, { field: "Age", value: "1½ years" }]);
  assert.deepEqual(factChips(DOGS[1], ["Breed"]), []);
  assert.deepEqual(factChips({ facts: { Age: "  " } }, ["Age"]), []);
  assert.deepEqual(factChips({}, ["Age"]), []);
});

test("filters: groups when there are both kinds, and only shared answers (never one-off breeds)", () => {
  const options = filterOptions(DOGS, RESCUE.factFields);
  assert.deepEqual(options.map((o) => o.label), ["All", "Single", "Groups", "Male", "Female"]);
  const allSingles = filterOptions(DOGS.slice(0, 4), RESCUE.factFields).map((o) => o.label);
  assert.deepEqual(allSingles, ["All", "Male", "Female"], "no group filter when there are no groups");
  assert.deepEqual(filterOptions([], RESCUE.factFields).map((o) => o.label), ["All"]);
});

test("browse list: filter and sort without changing the original list", () => {
  const options = filterOptions(DOGS, RESCUE.factFields);
  assert.deepEqual(browseList(DOGS, "Sex:Female", "waiting", options).map((d) => d.name), ["Fiona", "Becky"]);
  assert.deepEqual(browseList(DOGS, "groups", "waiting", options).map((d) => d.name), ["Golden Oldies"]);
  assert.deepEqual(browseList(DOGS, "all", "waiting", options).map((d) => d.name), ["Golden Oldies", "Fiona", "Becky", "Burt", "Dunkin"]);
  assert.deepEqual(browseList(DOGS, "all", "newest", options)[0].name, "Dunkin");
  assert.deepEqual(browseList(DOGS, "all", "name", options).map((d) => d.name), ["Becky", "Burt", "Dunkin", "Fiona", "Golden Oldies"]);
  assert.equal(browseList(DOGS, "made-up", "made-up", options).length, 5, "unknown filter or sort: everything, waiting longest");
  assert.equal(DOGS[0].name, "Burt", "the original order is untouched");
});

test("profiles introduce themselves the right way", () => {
  assert.deepEqual(profileHeading(DOGS[0], RESCUE), { title: "Hi, I'm Burt", tagline: "Will you be my sponsor?" });
  assert.deepEqual(profileHeading(DOGS[4], RESCUE), { title: "Meet the Golden Oldies", tagline: "Will you be our sponsor?" });
  const pantry = pageSettings({ kind: "program" });
  assert.deepEqual(profileHeading({ name: "Tuesday Family Night", note: "Groceries for a week", isGroup: true }, pantry), { title: "Tuesday Family Night", tagline: "Groceries for a week" });
  assert.equal(profileLabels(DOGS[0], RESCUE).why, "Why I need sponsoring");
  assert.equal(profileLabels(DOGS[4], RESCUE).about, "About us");
  assert.equal(profileLabels({ name: "Art Studio", isGroup: false }, pageSettings({ kind: "program" })).about, "About this program");
});

test("the new fields come through from the database, safely", () => {
  const np = { id: "np", slug: "x", name: "X", kind: "animal", monthly_price_cents: 2500, monthly_goal_cents: 200000, page: {} };
  const [burt, odd] = orgFromRows(np, [
    { id: "a", name: "Burt", facts: { Age: "1½ years" }, is_group: false, why: "Leash manners", loves: "Climbing", dislikes: "Waiting", created_at: "2026-11-01T00:00:00Z" },
    { id: "b", name: "Odd", facts: ["not", "an", "object"], is_group: "yes" },
  ]).items;
  assert.deepEqual([burt.facts, burt.isGroup, burt.why, burt.loves, burt.dislikes, burt.addedAt], [{ Age: "1½ years" }, false, "Leash manners", "Climbing", "Waiting", "2026-11-01T00:00:00Z"]);
  assert.deepEqual([odd.facts, odd.isGroup, odd.why], [{}, false, ""]);
});

test("icons are Cover's own fixed shapes", () => {
  for (const name of ICON_NAMES) assert.match(iconSvg(name), /^<svg [^>]*>.*<\/svg>$/);
  assert.equal(iconSvg("<script>"), iconSvg("heart"), "unknown names fall back to the heart");
  for (const t of Object.values(TEMPLATES)) for (const h of t.helps) assert.ok(ICON_NAMES.includes(h.icon), h.icon);
  for (const name of ICON_NAMES) assert.ok(ICON_LABELS[name], `plain name for ${name}`);
});

// ---------- phase 2: what owners fill in ----------

test("a dog with missing facts shows only the facts it has (never a blank box)", () => {
  const settings = pageSettings({ kind: "animal" });
  assert.deepEqual(factChips({ facts: { Age: "3 years" } }, settings.factFields), [{ field: "Age", value: "3 years" }], "no Breed or Sex chip at all");
  assert.deepEqual(factChips({ facts: { Age: "", Breed: "   ", Sex: null } }, settings.factFields), []);
  assert.deepEqual(factChips({ facts: {} }, settings.factFields), []);
});

test("the dog editor's extras: empty facts are dropped, limits enforced", async () => {
  const { validateItemExtras, FACT_PICKS } = await import("../docs/js/dashboard-logic.js");
  const ok = validateItemExtras({ facts: { Age: " 1½  years ", Breed: "", Sex: "Male" }, isGroup: true, why: " Leash manners ", loves: "Climbing", dislikes: "" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { facts: { Age: "1½ years", Sex: "Male" }, isGroup: true, why: "Leash manners", loves: "Climbing", dislikes: "" });
  assert.equal(validateItemExtras({ isGroup: "yes" }).values.isGroup, false, "only an explicit yes");
  const bad = validateItemExtras({ facts: { Age: "a".repeat(41) }, why: "a".repeat(601), loves: "a".repeat(121) });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["facts", "loves", "why"]);
  assert.deepEqual(FACT_PICKS.Sex, ["Male", "Female"]);
});

test("the sponsor page settings: tidy, empty rows dropped, half-filled rows flagged", async () => {
  const { validateSponsorSettings } = await import("../docs/js/dashboard-logic.js");
  const keys = Object.keys(TEMPLATES);
  const good = validateSponsorSettings({
    template: "rescue", firstPerson: true,
    factFields: ["Age", " Breed ", "", "Age"],
    stats: [{ value: "2,000+", label: "dogs placed" }, { value: "", label: "" }],
    helps: [{ icon: "bowl", title: "Food", text: "Meals" }, { icon: "heart", title: "", text: "" }],
    stories: [{ title: "Bella went home", text: "She did!", photo: "https://x/bella.jpg" }, { title: "", text: "" }],
    faq: [{ q: "Can I visit?", a: "Saturdays." }],
  }, keys);
  assert.equal(good.ok, true);
  assert.deepEqual(good.values, {
    template: "rescue", firstPerson: true, factFields: ["Age", "Breed"],
    stats: [{ value: "2,000+", label: "dogs placed" }],
    helps: [{ icon: "bowl", title: "Food", text: "Meals" }],
    stories: [{ title: "Bella went home", text: "She did!", photo: "https://x/bella.jpg" }],
    faq: [{ q: "Can I visit?", a: "Saturdays." }],
    updateMonths: [],
  });
  const half = validateSponsorSettings({ template: "rescue", stats: [{ value: "2,000+", label: "" }], faq: [{ q: "Only a question", a: "" }] }, keys);
  assert.equal(half.ok, false);
  assert.match(half.errors.stats, /both boxes/);
  assert.match(half.errors.faq, /both boxes/);
  const sneaky = validateSponsorSettings({ template: "hacker", stories: [{ title: "T", text: "X", photo: "javascript:alert(1)" }] }, keys);
  assert.equal(sneaky.values.template, null, "unknown kinds aren't saved");
  assert.deepEqual(sneaky.values.stories, [{ title: "T", text: "X" }], "unsafe photo links dropped");
  const long = validateSponsorSettings({ stats: [{ value: "a".repeat(25), label: "x" }] }, keys);
  assert.match(long.errors.stats, /under 24/);
});

test("what an owner saves is exactly what the new page reads back", async () => {
  const { validateSponsorSettings } = await import("../docs/js/dashboard-logic.js");
  const saved = validateSponsorSettings({
    template: "youth", firstPerson: false, factFields: ["Ages", "Sport"],
    stats: [{ value: "120", label: "kids every week" }], helps: [{ icon: "gear", title: "Gear", text: "Cleats and balls" }],
    stories: [], faq: [],
  }, Object.keys(TEMPLATES)).values;
  const settings = pageSettings({ kind: "program", ...saved });
  assert.deepEqual([settings.template, settings.firstPerson, settings.factFields], ["youth", false, ["Ages", "Sport"]]);
  assert.deepEqual(settings.stats, [{ value: "120", label: "kids every week" }]);
  assert.deepEqual(settings.helps, [{ icon: "gear", title: "Gear", text: "Cleats and balls" }]);
});

// ---------- phase 5: the switch, and the template at sign-up ----------

test("the old link forwards to the new page: same nonprofit, same dog", async () => {
  const { newPageLink } = await import("../docs/js/sponsor-page-logic.js");
  assert.equal(newPageLink("?org=Lucky-Pup-Rescue"), "sponsor.html?org=lucky-pup-rescue");
  assert.equal(newPageLink("?org=lucky-pup-rescue&dog=burt&sponsor=1"), "sponsor.html?org=lucky-pup-rescue&dog=burt");
  assert.equal(newPageLink(""), "sponsor.html?org=");
});

test("signing up: the kind of nonprofit picks the template and what supporters follow", async () => {
  const { validateSignup } = await import("../docs/js/dashboard-logic.js");
  const base = { name: "Harbor Paws", slug: "harbor-paws", followLabel: "Dogs", price: "25", goal: "2000" };
  assert.deepEqual([validateSignup({ ...base, template: "rescue" }).values.kind, validateSignup({ ...base, template: "rescue" }).values.template], ["animal", "rescue"]);
  assert.deepEqual([validateSignup({ ...base, template: "youth" }).values.kind, validateSignup({ ...base, template: "youth" }).values.template], ["program", "youth"]);
  assert.equal(validateSignup({ ...base, template: "casino" }).values.template, null, "unknown kinds are ignored");
  assert.equal(validateSignup({ ...base, kind: "animal" }).values.kind, "animal", "the old form still works");
  assert.equal(templateKey({ kind: "program", template: "health" }), "health");
});
