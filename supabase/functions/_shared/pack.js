// pack.js - the rules behind the sponsorship program emails (approved by Tanner, Nov 25, 2026):
// the welcome pack, the monthly update and the owner reminders. Plain code, so Node can test it.
//
//   * What a nonprofit's page says about itself (what supporters follow, what a gift helps with,
//     whether profiles talk in first person). Same defaults as docs/js/templates.js; a test keeps
//     the two in step, because the server can't load the website's files.
//   * "2 months together", "$25 a month": the numbers that make each email personal.
//   * When owners get reminded: a new sponsor with no first photo after 5 days, and each month,
//     5 days before it ends, for the dogs with sponsors but no update that month.

const TEMPLATE_DEFAULTS = {
  rescue: { follow: "Dogs", firstPerson: true, finishVerb: "is adopted", helps: ["Food", "Vet care", "Training", "Foster care"] },
  food: { follow: "Programs", firstPerson: false, finishVerb: "wraps up", helps: ["Groceries", "Fresh produce", "Volunteers", "Delivery"] },
  health: { follow: "Programs", firstPerson: false, finishVerb: "wraps up", helps: ["Equipment", "Family support", "Comfort items", "Special moments"] },
  youth: { follow: "Teams", firstPerson: false, finishVerb: "wraps up", helps: ["Gear", "Coaching", "Trips", "Snacks"] },
};

export const FIRST_UPDATE_NUDGE_DAYS = 5; // no first photo by day 5: remind the owner
export const FIRST_UPDATE_WINDOW_DAYS = 30; // older sponsors are covered by the monthly reminder
export const MONTHLY_REMINDER_DAYS_LEFT = 5; // the monthly reminder goes out with 5 days left in the month

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The defaults each kind of nonprofit starts with (exported so a test can compare them with the website's). */
export function templateDefaults() {
  return TEMPLATE_DEFAULTS;
}

/**
 * What the emails need from a nonprofit's page settings (nonprofits.page) and kind:
 * { one: "dog", firstPerson, finishVerb, helps: ["Food", ...], updateMonths: [..] }.
 */
export function pageBasics(page, kind) {
  const settings = page && typeof page === "object" ? page : {};
  const key = TEMPLATE_DEFAULTS[settings.template] ? settings.template : kind === "animal" ? "rescue" : "food";
  const t = TEMPLATE_DEFAULTS[key];
  const follow = isText(settings.navLabel, 30) && settings.navLabel !== "Sponsor" ? settings.navLabel : t.follow;
  const one = follow.length > 3 && /s$/i.test(follow) ? follow.slice(0, -1).toLowerCase() : follow.toLowerCase();
  const own = (Array.isArray(settings.helps) ? settings.helps : [])
    .filter((h) => h && isText(h.title, 40) && (!h.text || isText(h.text, 80))).slice(0, 6).map((h) => h.title.trim());
  const months = [...new Set((Array.isArray(settings.updateMonths) ? settings.updateMonths : []).map(Number)
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  return {
    one,
    firstPerson: typeof settings.firstPerson === "boolean" ? settings.firstPerson : t.firstPerson,
    finishVerb: t.finishVerb,
    helps: (own.length ? own : t.helps).slice(0, 4),
    updateMonths: months,
  };
}

/** "food, vet care, training and foster care" (each word lowercased unless it looks like a name). */
export function helpsList(titles) {
  const words = (titles ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => {
    const clean = t.trim();
    return /^[A-Z][a-z]/.test(clean) && !/[A-Z]/.test(clean.slice(1)) ? clean[0].toLowerCase() + clean.slice(1) : clean;
  });
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Every month", "3 times a year", "Twice a year": how often updates come (null schedule = every month). */
export function howOften(updateMonths) {
  const count = (updateMonths ?? []).length;
  if (!count || count === 12) return "Every month";
  if (count === 1) return "Once a year";
  if (count === 2) return "Twice a year";
  return `${count} times a year`;
}

/** How long a sponsorship has been going: "1 week", "3 weeks", "2 months", "1 year", "2 years". Null if unknown. */
export function togetherLabel(startIso, now = new Date()) {
  const start = new Date(startIso ?? "");
  if (!startIso || Number.isNaN(start.getTime())) return null;
  const days = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86400000));
  if (days < 30) {
    const weeks = Math.max(1, Math.floor(days / 7));
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  const months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth()
    - (now.getUTCDate() < start.getUTCDate() ? 1 : 0);
  if (months < 12) {
    const shown = Math.max(1, months);
    return `${shown} ${shown === 1 ? "month" : "months"}`;
  }
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

/** "$25" or "$25.50". */
export function dollars(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * The gift a sponsor chose, without the extra they added to cover Cover's fee (that part isn't the nonprofit's).
 * sponsor: { amount_cents, monthly_cents, covers_fee, fee_percent }. Null if there's no amount.
 */
export function chosenGiftCents(sponsor) {
  const total = Number(sponsor?.amount_cents ?? sponsor?.monthly_cents);
  if (!Number.isFinite(total) || total <= 0) return null;
  const percent = Number(sponsor?.fee_percent);
  if (sponsor?.covers_fee === true && percent > 0) return Math.floor((Math.round(total) * (100 - percent)) / 100);
  return Math.round(total);
}

/** "$25 a month", "$300 a year", or "$10" for a one-time gift. Null without an amount. */
export function amountPhrase(cents, interval) {
  if (!(Number(cents) > 0)) return null;
  if (interval === "year") return `${dollars(cents)} a year`;
  if (interval === "once") return dollars(cents);
  return `${dollars(cents)} a month`;
}

/** "December" for the month `now` is in, Eastern time (where Cover's pilots are). */
export function easternMonthName(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long" }).format(now);
}

/**
 * The monthly reminder due today, if any: today (Eastern, "YYYY-MM-DD") is 5 days before the month's last day.
 * Returns { dueOn: "2026-11-30", label: "November", monthStart: "2026-11-01" } or null.
 * Nonprofits that picked their own update months get the older "a week before" reminder instead.
 */
export function monthlyReminderDue(todayIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayIso ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (Number(m[3]) !== lastDay - MONTHLY_REMINDER_DAYS_LEFT) return null;
  const mm = String(month).padStart(2, "0");
  return { dueOn: `${year}-${mm}-${lastDay}`, label: MONTHS[month - 1], monthStart: `${year}-${mm}-01` };
}

/**
 * Sponsors whose owner should be nudged about a first photo: started 5 to 30 days ago, following someone,
 * and nothing has been sent about that someone since they started (and nothing is waiting to go out).
 * sponsors: [{ id, item_id, created_at }]; updates: [{ item_id, status, sent_at, created_at }]; nudged: Set of sponsor ids.
 */
export function needsFirstUpdate(sponsors, updates, nudged, now = new Date()) {
  const day = 86400000;
  return (sponsors ?? []).filter((s) => {
    if (!s.item_id || nudged?.has(s.id)) return false;
    const started = new Date(s.created_at).getTime();
    const age = now.getTime() - started;
    if (!Number.isFinite(started) || age < FIRST_UPDATE_NUDGE_DAYS * day || age > FIRST_UPDATE_WINDOW_DAYS * day) return false;
    return !(updates ?? []).some((u) => u.item_id === s.item_id && (
      u.status === "queued" || u.status === "sending" || (u.status === "sent" && new Date(u.sent_at ?? u.created_at).getTime() >= started)
    ));
  });
}

/** "Falkor", "Falkor and Becky", "Falkor, Becky and Dunkin". */
export function nameList(names) {
  const list = [...new Set((names ?? []).filter(Boolean))];
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
