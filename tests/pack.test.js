// pack.test.js - the sponsorship program emails (Nov 25, 2026): the welcome pack, the monthly update
// and the owner reminders, plus the rules behind them (supabase/functions/_shared/pack.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  amountPhrase, chosenGiftCents, helpsList, howOften, monthlyReminderDue, nameList, needsFirstUpdate, pageBasics, templateDefaults, togetherLabel,
} from "../supabase/functions/_shared/pack.js";
import {
  adoptionEmail, firstUpdateNudgeEmail, giftEmail, manageLinkEmail, monthlyReminderEmail, updateEmail, welcomeEmail,
} from "../supabase/functions/_shared/email.js";
import { TEMPLATES } from "../docs/js/templates.js";

const DAY = 86400000;
const PHOTO = "https://x.supabase.co/storage/v1/object/public/photos/falkor.jpg";
const FALKOR_NOTE = "An 18-month-old lab and Aussie mix who's fast, playful and loves his people, twigs and good smells on his walks.";
const welcome = {
  nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Sarah", itemName: "Falkor", interval: "month",
  certificateUrl: "https://covergiving.com/certificate.html?t=abc", manageUrl: "https://covergiving.com/gifts.html?t=m",
  isItem: true, about: FALKOR_NOTE, photoUrl: PHOTO, amountCents: 2500, holderName: "Sarah K.", page: {},
};

// ---------- the rules ----------

test("the server's page defaults match the website's templates", () => {
  for (const [key, defaults] of Object.entries(templateDefaults())) {
    const site = TEMPLATES[key];
    assert.ok(site, key);
    assert.equal(defaults.follow, site.follow, key);
    assert.equal(defaults.firstPerson, site.firstPerson, key);
    assert.equal(defaults.finishVerb, site.finishVerb, key);
    assert.deepEqual(defaults.helps, site.helps.map((h) => h.title), key);
  }
  assert.deepEqual(Object.keys(templateDefaults()).sort(), Object.keys(TEMPLATES).sort());
});

test("page basics: a rescue's defaults, and the owner's own choices win", () => {
  const rescue = pageBasics({}, "animal");
  assert.equal(rescue.one, "dog");
  assert.equal(rescue.firstPerson, true);
  assert.deepEqual(rescue.helps, ["Food", "Vet care", "Training", "Foster care"]);
  const own = pageBasics({ navLabel: "Cats", firstPerson: false, helps: [{ title: "Litter" }, { title: "" }, { title: "Shots" }], updateMonths: [12, 3, 3, 99] }, "animal");
  assert.equal(own.one, "cat");
  assert.equal(own.firstPerson, false);
  assert.deepEqual(own.helps, ["Litter", "Shots"], "empty entries are dropped");
  assert.deepEqual(own.updateMonths, [3, 12]);
  assert.equal(pageBasics(null, "program").one, "program");
});

test("helps list, how often and names read like a sentence", () => {
  assert.equal(helpsList(["Food", "Vet care", "Training", "Foster care"]), "food, vet care, training and foster care");
  assert.equal(helpsList(["BBQ nights", "Food"]), "BBQ nights and food", "words like BBQ keep their capitals");
  assert.equal(helpsList([]), "");
  assert.equal(howOften([]), "Every month");
  assert.equal(howOften([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "Every month");
  assert.equal(howOften([2, 7, 12]), "3 times a year");
  assert.equal(howOften([6]), "Once a year");
  assert.equal(nameList(["Falkor"]), "Falkor");
  assert.equal(nameList(["Falkor", "Becky", "Dunkin", "Becky"]), "Falkor, Becky and Dunkin");
});

test("time together: weeks first, then months, then years", () => {
  const now = new Date("2026-12-02T15:00:00Z");
  assert.equal(togetherLabel("2026-12-01T10:00:00Z", now), "1 week", "never 0 weeks");
  assert.equal(togetherLabel("2026-11-12T10:00:00Z", now), "2 weeks");
  assert.equal(togetherLabel("2026-10-02T10:00:00Z", now), "2 months");
  assert.equal(togetherLabel("2026-10-03T10:00:00Z", now), "1 month", "a month only counts once it's full");
  assert.equal(togetherLabel("2025-11-20T10:00:00Z", now), "1 year");
  assert.equal(togetherLabel("2023-01-01T10:00:00Z", now), "3 years");
  assert.equal(togetherLabel(null, now), null);
  assert.equal(togetherLabel("not a date", now), null);
});

test("the gift amount leaves out what they added to cover Cover's fee", () => {
  assert.equal(chosenGiftCents({ amount_cents: 2500, covers_fee: false, fee_percent: 3 }), 2500);
  assert.equal(chosenGiftCents({ amount_cents: 2578, covers_fee: true, fee_percent: 3 }), 2500);
  assert.equal(chosenGiftCents({ monthly_cents: 1000 }), 1000);
  assert.equal(chosenGiftCents({}), null);
  assert.equal(amountPhrase(2500, "month"), "$25 a month");
  assert.equal(amountPhrase(30000, "year"), "$300 a year");
  assert.equal(amountPhrase(1050, "once"), "$10.50");
  assert.equal(amountPhrase(0, "month"), null);
});

test("the monthly reminder is due 5 days before each month ends", () => {
  assert.deepEqual(monthlyReminderDue("2026-11-25"), { dueOn: "2026-11-30", label: "November", monthStart: "2026-11-01" });
  assert.deepEqual(monthlyReminderDue("2026-12-26"), { dueOn: "2026-12-31", label: "December", monthStart: "2026-12-01" });
  assert.equal(monthlyReminderDue("2027-02-23").dueOn, "2027-02-28");
  assert.equal(monthlyReminderDue("2028-02-24").dueOn, "2028-02-29", "leap years");
  assert.equal(monthlyReminderDue("2026-11-24"), null);
  assert.equal(monthlyReminderDue("nope"), null);
});

test("owners are nudged about a first photo after 5 days, once, and only when nothing was sent", () => {
  const now = new Date("2026-12-10T15:00:00Z");
  const ago = (days) => new Date(now.getTime() - days * DAY).toISOString();
  const sponsors = [
    { id: "new", item_id: "falkor", created_at: ago(2) },
    { id: "due", item_id: "falkor", created_at: ago(6) },
    { id: "old", item_id: "becky", created_at: ago(40) },
    { id: "whole", item_id: null, created_at: ago(6) },
    { id: "got-one", item_id: "dunkin", created_at: ago(8) },
    { id: "waiting", item_id: "zephyr", created_at: ago(7) },
    { id: "done", item_id: "gemma", created_at: ago(9) },
  ];
  const updates = [
    { item_id: "dunkin", status: "sent", sent_at: ago(3) },
    { item_id: "zephyr", status: "queued", sent_at: null },
    { item_id: "falkor", status: "sent", sent_at: ago(20), created_at: ago(20) }, // before "due" started: doesn't count
  ];
  const due = needsFirstUpdate(sponsors, updates, new Set(["done"]), now).map((s) => s.id);
  assert.deepEqual(due, ["due"]);
});

// ---------- the welcome pack ----------

test("the welcome pack: a letter from the dog, the certificate and what happens next", () => {
  const email = welcomeEmail(welcome);
  assert.equal(email.subject, "Welcome to Falkor's team, Sarah");
  for (const part of [
    "Hi Sarah! I&#39;m Falkor.", "Your $25 a month helps every dog at Lucky Pup Rescue", "say about me", "lab and Aussie mix",
    "food, vet care, training and foster care for me and every dog here", "Love, Falkor", "Sarah K.", "See my certificate",
    "What happens next", "This week:", "Every month:", "The day Falkor is adopted:", "My sponsorships", PHOTO,
  ]) assert.ok(email.html.includes(part), part);
  for (const part of ["Hi Sarah! I'm Falkor.", FALKOR_NOTE, "This week: your first photo of Falkor", "certificate.html?t=abc", "Manage my gift"]) {
    assert.ok(email.text.includes(part), part);
  }
  assert.doesNotMatch(email.html, /#22C67A|#0B6B47|border-radius/, "the new look: no old green, square edges");
});

test("the welcome pack only promises what really happens", () => {
  const scheduled = welcomeEmail({ ...welcome, page: { updateMonths: [3, 7, 11] } });
  assert.match(scheduled.text, /3 times a year: a new photo/);
  const once = welcomeEmail({ ...welcome, interval: "once", amountCents: 1000 });
  assert.equal(once.subject, "Thank you for your gift to Lucky Pup Rescue");
  assert.match(once.text, /Thank you for your \$10 gift/);
  assert.doesNotMatch(once.text, /What happens next|photos and news|Manage my gift/, "one-time givers aren't promised updates");
  const whole = welcomeEmail({ ...welcome, isItem: false, itemName: "Lucky Pup Rescue", about: "" });
  assert.doesNotMatch(whole.text, /This week|Hi Sarah! I'm/, "no updates promised without someone to follow");
  const program = welcomeEmail({ ...welcome, kind: "program", itemName: "Saturday Breakfast", about: "Breakfast for 80 families." });
  assert.doesNotMatch(program.text, /I'm Saturday Breakfast/);
  assert.match(program.text, /About Saturday Breakfast: Breakfast for 80 families\./);
  assert.match(program.text, /If Saturday Breakfast wraps up/);
  const group = welcomeEmail({ ...welcome, itemName: "Golden Oldies", isGroup: true });
  assert.match(group.text, /Hi Sarah! Meet the Golden Oldies\./);
  assert.match(group.text, /Love, the Golden Oldies/);
  const quiet = welcomeEmail({ ...welcome, page: { firstPerson: false } });
  assert.doesNotMatch(quiet.text, /I'm Falkor/, "owners who turned first person off don't get a letter in the dog's voice");
});

test("nothing typed into a profile can add HTML to the welcome pack", () => {
  const email = welcomeEmail({ ...welcome, about: '"><script>alert(1)</script>', firstName: "<b>Sarah</b>", holderName: "<i>x</i>", photoUrl: "javascript:alert(1)" });
  assert.ok(!email.html.includes("<script>") && !email.html.includes("<b>Sarah") && !email.html.includes("<i>x"));
  assert.ok(!email.html.includes("javascript:"), "only https photos");
});

// ---------- the monthly update ----------

test("the monthly update: the owner's line, months together and what the gift helped with", () => {
  const sentAt = "2026-12-02T15:00:00Z";
  const details = {
    nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Sarah", itemName: "Falkor", body: "Falkor learned to wait for his dinner.",
    photoUrl: PHOTO, stopUrl: "https://covergiving.com/updates.html?a=stop&t=s", manageUrl: "https://covergiving.com/gifts.html?t=m",
    startedAt: "2026-10-01T12:00:00Z", amountCents: 2500, interval: "month", helps: ["Food", "Vet care", "Training", "Foster care"], one: "dog", sentAt,
  };
  const email = updateEmail(details);
  assert.equal(email.subject, "Falkor's December update");
  for (const part of ["2 months", "you and Falkor, together", "This month, your $25 helped with",
    "Food, vet care, training and foster care for every dog at Lucky Pup Rescue.", "See all of Falkor&#39;s updates", "Thank you for being on Falkor"]) {
    assert.ok(email.html.includes(part), part);
  }
  assert.match(email.text, /2 months: you and Falkor, together\./);
  assert.match(email.text, /See all of Falkor's updates: https:\/\/covergiving\.com\/gifts\.html\?t=m/);
  const yearly = updateEmail({ ...details, interval: "year", amountCents: 30000 });
  assert.match(yearly.text, /Your \$300 a year helps with food/);
  const gift = updateEmail({ ...details, manageUrl: null, giftFrom: "Sarah", firstName: "Mom" });
  assert.match(gift.text, /Sarah's gift helps with food/);
  assert.doesNotMatch(gift.text, /See all of Falkor's updates/, "the person a gift is for has no My sponsorships link");
  const plain = updateEmail({ ...details, startedAt: null, amountCents: null });
  assert.doesNotMatch(plain.text, /together/);
  assert.match(plain.text, /Your gift helps with food/);
});

// ---------- owner reminders ----------

test("owner reminders say which dogs and what to do", () => {
  const one = firstUpdateNudgeEmail({ nonprofitName: "Lucky Pup Rescue", names: ["Falkor"], dashboardUrl: "https://covergiving.com/dashboard.html" });
  assert.equal(one.subject, "Falkor's new sponsor is waiting for a first photo");
  assert.match(one.text, /Falkor has a new sponsor/);
  assert.match(one.text, /about a minute/);
  const two = firstUpdateNudgeEmail({ nonprofitName: "Lucky Pup Rescue", names: ["Falkor", "Becky"], dashboardUrl: "https://covergiving.com/dashboard.html" });
  assert.match(two.text, /Falkor and Becky have a new sponsor/);
  const monthly = monthlyReminderEmail({ nonprofitName: "Lucky Pup Rescue", monthLabel: "December", names: ["Falkor", "Becky", "Dunkin"], dashboardUrl: "https://covergiving.com/dashboard.html" });
  assert.equal(monthly.subject, "Time for December updates to your sponsors");
  assert.match(monthly.text, /Falkor, Becky and Dunkin have sponsors waiting on a December update/);
  assert.match(monthly.html, /Open my dashboard/);
});

test("every sponsor email uses the new look", () => {
  const emails = [
    adoptionEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Sarah", finishedName: "Falkor", ownerNote: "", pickUrl: null, stopUrl: "https://covergiving.com/s" }),
    giftEmail({ nonprofitName: "Lucky Pup Rescue", recipientName: "Mom", giverName: "Sarah", itemName: "Falkor", interval: "month", message: "", certificateUrl: "https://covergiving.com/c", stopUrl: "https://covergiving.com/s" }),
    manageLinkEmail("https://covergiving.com/gifts.html?t=m"),
  ];
  for (const email of emails) {
    assert.doesNotMatch(email.html, /#22C67A|#0B6B47|border-radius| · /, email.subject);
    assert.match(email.html, /#4B5A2A/, email.subject);
  }
});
