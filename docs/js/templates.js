// templates.js - the starting setup for each kind of nonprofit on the new sponsor pages (Nov 23, 2026).
// A template fills in what a page needs so nobody starts from a blank form: what supporters follow,
// which facts show on each card, the "your gift helps with" list, whether profiles speak in first person
// ("Hi, I'm Burt"), and whether groups are the default. The owner can change any of it (page settings).
// Hospitals and youth programs default to groups: never single patients or kids without consent.

export const TEMPLATES = {
  rescue: {
    label: "Animal rescue",
    follow: "Dogs",
    one: "dog",
    firstPerson: true,
    groupsDefault: false,
    factFields: ["Age", "Breed", "Sex"],
    finishVerb: "is adopted",
    helps: [
      { icon: "bowl", title: "Food", text: "Good meals every day" },
      { icon: "health", title: "Vet care", text: "Checkups, shots and medicine" },
      { icon: "learn", title: "Training", text: "Getting ready for a home" },
      { icon: "home", title: "Foster care", text: "A safe, warm place to wait" },
    ],
  },
  food: {
    label: "Food program",
    follow: "Programs",
    one: "program",
    firstPerson: false,
    groupsDefault: true,
    factFields: ["Day", "Program"],
    finishVerb: "wraps up",
    helps: [
      { icon: "cart", title: "Groceries", text: "Food for families every week" },
      { icon: "leaf", title: "Fresh produce", text: "Fruit and vegetables" },
      { icon: "hands", title: "Volunteers", text: "Supplies for the people who help" },
      { icon: "truck", title: "Delivery", text: "Food for people who can't get here" },
    ],
  },
  health: {
    label: "Hospital or health",
    follow: "Programs",
    one: "program",
    firstPerson: false,
    groupsDefault: true,
    factFields: ["Unit", "Need"],
    finishVerb: "wraps up",
    helps: [
      { icon: "health", title: "Equipment", text: "What the care team needs" },
      { icon: "heart", title: "Family support", text: "Meals, parking and rest" },
      { icon: "home", title: "Comfort items", text: "Blankets, books and toys" },
      { icon: "star", title: "Special moments", text: "Birthdays and milestones" },
    ],
  },
  youth: {
    label: "Youth program",
    follow: "Teams",
    one: "team",
    firstPerson: false,
    groupsDefault: true,
    factFields: ["Ages", "Activity"],
    finishVerb: "wraps up",
    helps: [
      { icon: "gear", title: "Gear", text: "Uniforms and equipment" },
      { icon: "learn", title: "Coaching", text: "Coaches and mentors" },
      { icon: "bus", title: "Trips", text: "Getting to games and events" },
      { icon: "bowl", title: "Snacks", text: "Something to eat after school" },
    ],
  },
};

/** Which template a nonprofit uses: the one they picked, or a sensible guess from what they follow. */
export function templateKey(org) {
  const picked = org?.template;
  if (picked && TEMPLATES[picked]) return picked;
  return org?.kind === "animal" ? "rescue" : "food";
}

/** A tidy, short list of strings from whatever the page settings hold (bad entries dropped). */
function cleanList(value, max, keep) {
  return (Array.isArray(value) ? value : []).filter(keep).slice(0, max);
}

const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Everything the new sponsor pages need about one nonprofit: the template's defaults, overridden by
 * whatever the owner set. org is the shape live.js makes (its page settings are spread onto it).
 */
export function pageSettings(org) {
  const key = templateKey(org);
  const t = TEMPLATES[key];
  const follow = isText(org?.navLabel, 30) && org.navLabel !== "Sponsor" ? org.navLabel : t.follow;
  const one = follow.length > 3 && /s$/i.test(follow) ? follow.slice(0, -1).toLowerCase() : follow.toLowerCase();
  const factFields = cleanList(org?.factFields, 4, (f) => isText(f, 30));
  const helps = cleanList(org?.helps, 6, (h) => h && isText(h.title, 40) && (!h.text || isText(h.text, 80)));
  return {
    template: key,
    follow,
    one,
    firstPerson: typeof org?.firstPerson === "boolean" ? org.firstPerson : t.firstPerson,
    groupsDefault: t.groupsDefault,
    finishVerb: t.finishVerb,
    factFields: factFields.length ? factFields : t.factFields,
    helps: (helps.length ? helps : t.helps).map((h) => ({ icon: h.icon ?? "heart", title: h.title, text: h.text ?? "" })),
    stats: cleanList(org?.stats, 3, (s) => s && isText(s.value, 24) && isText(s.label, 80)),
    stories: cleanList(org?.stories, 3, (s) => s && isText(s.title, 80) && isText(s.text, 600)),
    extraFaq: cleanList(org?.faq, 6, (q) => q && isText(q.q, 120) && isText(q.a, 600)),
    updateMonths: cleanUpdateMonths(org?.updateMonths),
  };
}

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The months (1-12) a nonprofit sends updates in, tidied: [2, 7, 12]. */
export function cleanUpdateMonths(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
}

/** "3 times a year", "every month", or null when the nonprofit hasn't picked a schedule. */
export function scheduleText(updateMonths) {
  const count = cleanUpdateMonths(updateMonths).length;
  if (!count) return null;
  if (count === 12) return "every month";
  return `${count === 1 ? "once" : count === 2 ? "twice" : `${count} times`} a year`;
}

/** What sponsors get. Only what Cover really does. */
export function receiveList(settings, name = null) {
  const who = name ?? `your ${settings.one}`;
  const often = scheduleText(settings.updateMonths);
  return [
    `A photo certificate to keep or print`,
    often ? `Photo updates about ${who}, ${often}` : `Photo updates and news about ${who}`,
    `A note if ${who} ${settings.finishVerb}, and the chance to pick someone new`,
    "Change or cancel anytime, online",
  ];
}

/** The questions every page answers (true for every Cover nonprofit), then the owner's own. */
export function faqList(settings, orgName, feeOn = false) {
  return [
    { q: `Am I the only sponsor?`, a: `No. Many people sponsor each ${settings.one}, and every gift goes into one fund for everyone at ${orgName}.` },
    {
      q: `What happens if my ${settings.one} ${settings.finishVerb}?`,
      a: `We'll email you the news and ask who you'd like to follow next. Your gift keeps going unless you change it.`,
    },
    {
      q: "Where does my money go?",
      a: `Straight to ${orgName}'s own account through Stripe. Cover never holds it.${feeOn ? " Cover keeps 3% of each gift, shown before you pay." : ""}`,
    },
    { q: "Can I change or cancel?", a: "Yes, anytime, from the link in any email we send." },
    ...settings.extraFaq,
  ];
}
