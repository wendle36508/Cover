// sponsor.js - the rules for signing up a sponsor on a Cover page.
// Pure functions only (no page or storage code), so every rule can be tested on its own.
// Written in JavaScript because it runs in the visitor's browser, which can't run Python.

export const LIMITS = { firstName: 40, email: 254, businessName: 80 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ANONYMOUS_NAME = "A neighbor";

/**
 * The optional last initial for the thank-you wall: "k", "K." or " K " -> "K". Empty -> "".
 * Anything else (two letters, a number) -> null, which the form shows as an error.
 */
export function cleanInitial(value) {
  const raw = typeof value === "string" ? value.replace(/[.\s]/g, "") : "";
  if (!raw) return "";
  return /^[A-Za-z]$/.test(raw) ? raw.toUpperCase() : null;
}

/** Trim a form value and squash repeated spaces. Anything that isn't text becomes "". */
export function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Check the sponsor form. Returns { ok, errors, values }.
 * errors maps a field name to a short message the page shows under that field.
 */
export function validateSponsor(form) {
  const values = {
    firstName: cleanText(form?.firstName),
    email: cleanText(form?.email).toLowerCase(),
    showName: Boolean(form?.showName),
    lastInitial: form?.showName ? cleanInitial(form?.lastInitial) : "",
    isBusiness: Boolean(form?.isBusiness),
    businessName: cleanText(form?.businessName),
  };
  const errors = {};

  if (!values.firstName) errors.firstName = "Add your first name.";
  else if (values.firstName.length > LIMITS.firstName) errors.firstName = `Keep it under ${LIMITS.firstName} characters.`;

  if (!values.email) errors.email = "Add your email so we can send updates.";
  else if (values.email.length > LIMITS.email || !EMAIL_PATTERN.test(values.email)) errors.email = "That email doesn't look right.";

  if (values.lastInitial === null) {
    errors.lastInitial = "Just one letter, like K.";
    values.lastInitial = "";
  }

  if (values.isBusiness) {
    if (!values.businessName) errors.businessName = "Add your business name.";
    else if (values.businessName.length > LIMITS.businessName) errors.businessName = `Keep it under ${LIMITS.businessName} characters.`;
  } else {
    values.businessName = "";
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** A unique id for a new sponsor record. */
export function newId(random = Math.random, now = Date.now) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${now().toString(36)}-${random().toString(36).slice(2, 10)}`;
}

/**
 * The record saved for a new sponsor. It starts as "pending" until the nonprofit
 * confirms the first payment arrived (Cover never sees the money itself).
 */
export function buildRecord(values, orgKey, org, item, now = new Date(), makeId = newId) {
  if (!org || !item) throw new Error("A sponsor record needs a nonprofit and something to follow.");
  return {
    id: makeId(),
    orgKey,
    itemName: item.name,
    firstName: values.firstName,
    email: values.email,
    showName: values.showName,
    lastInitial: values.lastInitial || null,
    businessName: values.isBusiness ? values.businessName : null,
    monthly: org.price,
    status: "pending",
    createdAt: now.toISOString(),
  };
}

/**
 * The name shown publicly, only if they ticked the thank-you wall box: the business name, or
 * "Sarah K." (first name + last initial). Otherwise "A neighbor". Matches the database's wall_name.
 */
export function publicName(record) {
  if (!record.showName) return ANONYMOUS_NAME;
  if (record.businessName) return record.businessName;
  return record.lastInitial ? `${record.firstName} ${record.lastInitial}.` : record.firstName;
}

/** The thank-you note signed by the animal or program they picked. */
export function thankYou(record, org, item) {
  const amount = money(org.price);
  const body =
    org.kind === "animal"
      ? `I'll send you my first update soon. Your ${amount} a month helps ${org.everyone}.`
      : `You'll get our first update next month. Your ${amount} a month helps ${org.everyone}.`;
  return { title: `Thanks, ${record.firstName}!`, body, signedBy: item.name };
}

/** The nonprofit's own donation page, or null in demo mode or if the link isn't a safe https link. */
export function paymentUrl(org) {
  if (!org.donateUrl) return null;
  try {
    const url = new URL(org.donateUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Page numbers after a new sponsor joins. Returns new objects; the inputs aren't changed. */
export function withNewSponsor(org, itemName) {
  const covered = org.covered + org.price;
  const items = org.items.map((item) => (item.name === itemName ? { ...item, sponsors: item.sponsors + 1 } : item));
  return { ...org, covered, items };
}

/** Percent of the monthly goal covered, from 0 to 100. */
export function percentCovered(covered, goal) {
  if (!(goal > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((covered / goal) * 100)));
}

/** Whole dollars, like "$1,600". */
export function money(amount) {
  return "$" + Math.round(amount).toLocaleString("en-US");
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". Future or bad times read "just now". */
export function timeAgo(isoTime, now = new Date()) {
  const seconds = (now.getTime() - new Date(isoTime).getTime()) / 1000;
  if (!(seconds >= 60)) return "just now";
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** Text for the sponsor count on a card, like "1 sponsor" or "12 sponsors". */
export function sponsorLabel(count) {
  return `${count} sponsor${count === 1 ? "" : "s"}`;
}
