// store.js - where sponsor sign-ups are saved.
// For now (step A) they stay in this browser only, so the page can be tried on a laptop.
// Step B swaps this file's insides for a real database (Supabase); the rest of the site won't change.

const KEY = "cover.sponsors.v1";

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private windows and blocked storage
  }
}

/** Every saved sponsor record (newest last). Bad or missing data gives an empty list. */
export function loadSponsors(storage = browserStorage()) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save one new sponsor. Returns true if it was saved. */
export function saveSponsor(record, storage = browserStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify([...loadSponsors(storage), record]));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

/** Sponsors saved for one nonprofit. */
export function sponsorsFor(orgKey, storage = browserStorage()) {
  return loadSponsors(storage).filter((record) => record.orgKey === orgKey);
}

/** Forget every saved sponsor (used to reset the demo). */
export function clearSponsors(storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
