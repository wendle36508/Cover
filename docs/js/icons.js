// icons.js - simple line icons for "Your gift helps with" on the sponsor pages. They draw in the
// current text color (currentColor), so the page's brand color and any rebrand restyle them for free.
// Each is a 24x24 outline. Unknown names fall back to the heart.

const PATHS = {
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/>',
  health: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  learn: '<path d="M2 9l10-5 10 5-10 5Z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  cart: '<path d="M3 4h2l2.5 11h11L21 8H6.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19c3-4 6-7 10-9"/>',
  hands: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v5M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6c0 4-2 8-6 8-3 0-5-2-6.5-4.5L2 13a1.5 1.5 0 0 1 2.5-1.5L7 14"/>',
  truck: '<path d="M2 6h11v10H2z"/><path d="M13 9h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  heart: '<path d="M12 20s-8-4.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6.5-8 11-8 11Z"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  bus: '<rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><circle cx="8" cy="20" r="1.5"/><circle cx="16" cy="20" r="1.5"/>',
};

/** The SVG markup for an icon name (always one of Cover's own fixed shapes, never user text). */
export function iconSvg(name) {
  const path = PATHS[name] ?? PATHS.heart;
  return `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);

/** Plain names for the icon menu in the dashboard (owners pick by meaning, not by code name). */
export const ICON_LABELS = {
  bowl: "Food bowl", health: "Medical", learn: "Learning", home: "Home", cart: "Groceries", leaf: "Fresh food",
  hands: "Helping hands", truck: "Delivery", heart: "Heart", star: "Star", gear: "Gear", bus: "Bus",
};
