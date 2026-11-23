// after-signup.js - the rules for what happens after someone signs up (phase 4, Nov 23, 2026):
// who each email goes to (the giver, or the person a gift is for), what the photo certificate shows,
// and when an owner's update reminder is due. Plain code, so Node can test it.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const REMINDER_DAYS_BEFORE = 7;

/**
 * Who gets a sponsor's emails (updates, adoption notes). A gift goes to the person it's for, but only
 * once their gift email has arrived; before that, nobody (so the surprise isn't spoiled).
 * Returns { to, firstName, giftFrom } or null.
 */
export function recipientFor(sponsor) {
  if (sponsor?.gift_email) {
    if (!sponsor.gift_sent_at) return null;
    return { to: sponsor.gift_email, firstName: sponsor.gift_name, giftFrom: sponsor.first_name };
  }
  return sponsor?.email ? { to: sponsor.email, firstName: sponsor.first_name, giftFrom: null } : null;
}

/** "Sarah K.", a business name, or just "Sarah": how a sponsor's name reads on their certificate. */
function displayName(sponsor) {
  if (sponsor.business_name) return sponsor.business_name;
  return sponsor.last_initial ? `${sponsor.first_name} ${sponsor.last_initial}.` : sponsor.first_name;
}

/** "November 2026". */
export function monthYear(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const httpsOnly = (url) => (typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);

/** Everything the certificate page shows. Nothing private (no email, no amount). */
export function certificateView({ sponsor, nonprofit, item }) {
  const page = nonprofit?.page ?? {};
  const gift = Boolean(sponsor.gift_name);
  return {
    holder: gift ? sponsor.gift_name : displayName(sponsor),
    giftFrom: gift ? sponsor.first_name : null,
    itemName: item?.name ?? nonprofit?.name ?? "",
    photoUrl: httpsOnly(item?.photo_url) ?? httpsOnly(page.coverPhoto),
    focus: item ? `${item.photo_focus_x ?? 50}% ${item.photo_focus_y ?? 38}%` : "50% 40%",
    orgName: nonprofit?.name ?? "",
    kind: nonprofit?.kind ?? "program",
    logo: httpsOnly(page.logo),
    brandColor: typeof page.brandColor === "string" ? page.brandColor : null,
    since: monthYear(sponsor.created_at),
    once: sponsor.interval === "once",
  };
}

/** The months a nonprofit sends updates in (1-12), tidied: [2, 7, 12]. Same rule as docs/js/templates.js. */
export function cleanUpdateMonths(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
}

/**
 * Reminders due today: one for each chosen month whose 1st is exactly a week away.
 * todayIso is "YYYY-MM-DD" (Eastern time). Returns [{ dueOn: "2026-12-01", label: "December" }].
 */
export function remindersDue(updateMonths, todayIso) {
  const today = new Date(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(today.getTime())) return [];
  const target = new Date(today.getTime() + REMINDER_DAYS_BEFORE * 86400000);
  if (target.getUTCDate() !== 1) return [];
  const month = target.getUTCMonth() + 1;
  if (!cleanUpdateMonths(updateMonths).includes(month)) return [];
  return [{ dueOn: target.toISOString().slice(0, 10), label: MONTHS[month - 1] }];
}
