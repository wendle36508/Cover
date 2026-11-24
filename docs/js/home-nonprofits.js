// home-nonprofits.js - the homepage's "Sponsor a local nonprofit" section. Shows every live nonprofit on
// Cover straight from the database: one big featured card while there's one, a photo grid once there are
// more. Stays hidden when nothing is live (never an empty or "coming soon" grid). Text is set with
// textContent. Drawn in Cover's "Full photo" look (css/brand.css): photo edge to edge, name on a fade.

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { cleanNonprofits, layoutFor, pageLink, sponsorLine } from "./home-nonprofits-logic.js";

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function img(src, alt, focus) {
  const node = el("img");
  node.src = src;
  node.alt = alt;
  node.loading = "lazy";
  if (focus) node.style.objectPosition = focus;
  return node;
}

function arrow(color) {
  const node = img(`brand/drawings/arrow-${color}.png`, "");
  return node;
}

/** The big photo with the nonprofit's name (and town) on a deep moss fade. */
function photoBlock(np, tag, className) {
  const block = el(tag, `photo dark ${className}`);
  if (tag === "a") block.href = pageLink(np);
  const cover = np.coverPhoto || np.items[0]?.photo;
  if (cover) block.append(img(cover, "", "50% 30%"));
  block.append(el("div", "fade up"));
  const words = el("div", "words");
  if (np.place) words.append(el("span", "label", np.place));
  words.append(el("h3", "", np.name));
  block.append(words);
  return block;
}

/** One nonprofit: the photo, its headline, a few of the ones you can sponsor, and a button. */
function featured(np) {
  const box = el("div", "np-featured");
  box.append(photoBlock(np, "a", ""));
  const side = el("div", "np-side");
  if (np.logo) {
    const org = el("div", "np-org");
    org.append(img(np.logo, ""), el("span", "", np.name));
    side.append(org);
  }
  if (np.headline) side.append(el("p", "", np.headline));
  if (np.items.length) {
    const dogs = el("div", "np-dogs");
    dogs.append(...np.items.map((item) => {
      const link = el("a", "np-dog");
      link.href = pageLink(np, item.name);
      const words = el("div");
      words.append(el("b", "", item.name), el("span", "", `Sponsor ${item.name}`));
      link.append(img(item.photo, item.name, item.focus), words);
      return link;
    }));
    side.append(dogs);
  }
  const cta = el("a", "btn btn-moss", sponsorLine(np));
  cta.href = pageLink(np);
  cta.append(arrow("cream"));
  side.append(cta);
  box.append(side);
  return box;
}

/** Two or more nonprofits: one full-photo card each. */
function card(np) {
  const block = el("a", "photo dark np-card");
  block.href = pageLink(np);
  const cover = np.coverPhoto || np.items[0]?.photo;
  if (cover) block.append(img(cover, "", "50% 30%"));
  block.append(el("div", "fade up"));
  const words = el("div", "words");
  words.append(el("h3", "", np.name));
  if (np.place) words.append(el("p", "where", np.place));
  const more = el("span", "textlink", sponsorLine(np));
  more.append(arrow("cream"));
  words.append(more);
  block.append(words);
  return block;
}

async function loadNonprofits() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/live_nonprofits`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`live_nonprofits ${response.status}`);
  return cleanNonprofits(await response.json());
}

async function draw() {
  let nonprofits = [];
  try {
    nonprofits = await loadNonprofits();
  } catch (error) {
    console.warn("Couldn't load the live nonprofits; the section stays hidden.", error);
    return;
  }
  const layout = layoutFor(nonprofits.length);
  if (layout === "hidden") return;
  $("np-list").className = layout === "featured" ? "" : "np-grid";
  $("np-list").replaceChildren(...(layout === "featured" ? [featured(nonprofits[0])] : nonprofits.map(card)));
  $("nonprofits").hidden = false;
}

draw();
