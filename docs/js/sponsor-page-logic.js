// sponsor-page-logic.js - the rules behind the new sponsor pages (sponsor.html), kept apart from the
// page itself so Node can test them: which page to show, fact chips, the browse list's filters and
// sorting, and how a profile introduces itself.

import { itemSlug } from "./sponsor.js";

const FILTER_MAX_VALUES = 5; // a fact becomes a filter only when it has a few shared answers (like Sex)

/** Which page the link asks for: the home page, the browse list, or one profile. */
export function readView(search, items) {
  const params = new URLSearchParams(search ?? "");
  const wanted = params.get("dog");
  if (wanted) {
    const item = (items ?? []).find((one) => itemSlug(one.name) === itemSlug(wanted));
    if (item) return { page: "profile", item };
  }
  return { page: params.get("view") === "all" ? "browse" : "home", item: null };
}

/**
 * Where an old give.html link goes once a nonprofit uses the new page: the same nonprofit and dog,
 * so every shared link, QR code and printed sign keeps working.
 */
export function newPageLink(search) {
  const params = new URLSearchParams(search ?? "");
  const next = new URLSearchParams({ org: (params.get("org") ?? "").toLowerCase() });
  if (params.get("dog")) next.set("dog", params.get("dog"));
  return `sponsor.html?${next}`;
}

/** The link for a view of this nonprofit's sponsor pages. */
export function viewLink(orgSlug, page, item = null) {
  const params = new URLSearchParams({ org: orgSlug });
  if (page === "browse") params.set("view", "all");
  if (page === "profile" && item) params.set("dog", itemSlug(item.name));
  return `sponsor.html?${params}`;
}

/** The fact chips for a card or profile, in the nonprofit's chosen order: [{ field, value }]. */
export function factChips(item, factFields) {
  const facts = item?.facts ?? {};
  return (factFields ?? [])
    .map((field) => ({ field, value: typeof facts[field] === "string" ? facts[field].trim() : "" }))
    .filter((chip) => chip.value);
}

/**
 * The filter chips above the browse list: All, then Single/Groups when both exist, then the answers
 * of any fact with a few repeating values (Male / Female). Returns [{ key, label, test }].
 */
export function filterOptions(items, factFields) {
  const list = items ?? [];
  const options = [{ key: "all", label: "All", test: () => true }];
  const groups = list.filter((item) => item.isGroup).length;
  if (groups > 0 && groups < list.length) {
    options.push({ key: "single", label: "Single", test: (item) => !item.isGroup });
    options.push({ key: "groups", label: "Groups", test: (item) => item.isGroup });
  }
  for (const field of factFields ?? []) {
    // Only answers that at least two of them share (Male / Female), never one-off answers like a breed.
    const counts = new Map();
    for (const item of list) {
      const value = item.facts?.[field]?.trim();
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const values = [...counts].filter(([, count]) => count >= 2).map(([value]) => value);
    if (values.length < 2 || values.length > FILTER_MAX_VALUES) continue;
    for (const value of values) {
      options.push({ key: `${field}:${value}`, label: value, test: (item) => item.facts?.[field]?.trim() === value });
    }
  }
  return options;
}

export const SORTS = {
  waiting: { label: "Waiting longest", compare: (a, b) => time(a.addedAt) - time(b.addedAt) },
  newest: { label: "Newest", compare: (a, b) => time(b.addedAt) - time(a.addedAt) },
  name: { label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
};

function time(value) {
  const t = new Date(value ?? 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The browse list after a filter and a sort (the original list is left alone). */
export function browseList(items, filterKey, sortKey, options) {
  const filter = (options ?? []).find((option) => option.key === filterKey) ?? { test: () => true };
  const sort = SORTS[sortKey] ?? SORTS.waiting;
  return (items ?? []).filter(filter.test).sort(sort.compare);
}

/** How a profile introduces itself: "Hi, I'm Burt" for animals (when first person is on), else the name. */
export function profileHeading(item, settings) {
  if (settings.firstPerson && !item.isGroup) return { title: `Hi, I'm ${item.name}`, tagline: "Will you be my sponsor?" };
  if (settings.firstPerson && item.isGroup) return { title: `Meet the ${item.name}`, tagline: "Will you be our sponsor?" };
  return { title: item.name, tagline: item.note || "" };
}

/** The profile's section headings, in first person or not ("About me" / "About this program"). */
export function profileLabels(item, settings) {
  const first = settings.firstPerson;
  if (item.isGroup) {
    return { about: first ? "About us" : `About ${item.name}`, why: first ? "Why we need sponsoring" : "Why it needs sponsors", loves: first ? "We love" : "Loves", dislikes: first ? "We're not fans of" : "Not a fan of" };
  }
  return {
    about: first ? "About me" : `About this ${settings.one}`,
    why: first ? "Why I need sponsoring" : "Why it needs sponsors",
    loves: first ? "I love" : "Loves",
    dislikes: first ? "I'm not a fan of" : "Not a fan of",
  };
}
