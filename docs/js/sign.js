// sign.js - the printable "Sponsor me" sign (sign.html?org=lucky-pup-rescue&dog=burt).
// Opened from the dashboard's Share box. Shows the nonprofit's logo, the dog's (or cover) photo, a big
// QR code and the short share link. Works for pages that aren't live yet when the owner is signed in.

import { applyBrand, safeImageUrl } from "./brand.js";
import { loadLiveOrg } from "./live.js";
import { drawQr, shareLink } from "./share.js";
import { findItemBySlug, midSentence, money } from "./sponsor.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** "Dogs" -> "dog" for "Sponsor a dog"; null when the label isn't a single plural word. */
function singular(label) {
  const word = String(label ?? "").trim().toLowerCase();
  if (!word || word === "sponsor" || word.includes(" ")) return null;
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function problem(text) {
  $("sign").replaceChildren(el("p", "problem", text));
}

async function start() {
  $("print").addEventListener("click", () => print());
  let org = null;
  try {
    org = await loadLiveOrg(String(params.get("org") ?? "").toLowerCase());
  } catch {
    // shown below
  }
  if (!org) return problem("We couldn't find that page. Open the sign from your dashboard's Share button while you're signed in.");
  applyBrand(document.body, org.brandColor);
  const item = findItemBySlug(org.items, params.get("dog"));
  const one = singular(org.navLabel);
  document.title = `Sign: ${item ? item.name : org.name} | Cover`;

  const sheet = el("div", "sheet");
  const top = el("div", "org");
  const logo = safeImageUrl(org.logo);
  if (logo) {
    const img = el("img");
    img.src = logo;
    img.alt = "";
    top.append(img);
  }
  top.append(el("span", "", org.name));
  sheet.append(top);
  sheet.append(el("h1", "", item ? `Sponsor ${item.name}` : one ? `Sponsor a ${one}` : `Sponsor ${org.name}`));
  sheet.append(el("p", "at", item ? `at ${org.name}` : one ? `at ${org.name}` : "Monthly sponsorship"));

  const photoUrl = item ? item.photo : safeImageUrl(org.heroPhotoWide) || org.items[0]?.photo;
  if (photoUrl) {
    const photo = el("img", "photo");
    photo.src = photoUrl;
    photo.alt = item ? item.name : org.name;
    if (item?.focus) photo.style.objectPosition = item.focus;
    sheet.append(photo);
  }

  const link = shareLink(org.slug, item?.name ?? null);
  const scan = el("div", "scan");
  const canvas = el("canvas");
  const words = el("div");
  words.append(
    el("b", "", "Scan with your phone camera"),
    el("span", "link", link.replace(/^https:\/\//, "")),
    el("p", "", `${money(org.price)} a month. Every gift goes into one fund for ${midSentence(org.everyone)}.`),
  );
  scan.append(canvas, words);
  sheet.append(scan);

  const foot = el("p", "foot", "Powered by");
  const cover = el("img");
  cover.src = "brand/logo.svg";
  cover.alt = "Cover";
  foot.append(cover);
  sheet.append(foot);
  $("sign").replaceChildren(sheet);
  if (!(await drawQr(canvas, link, 900))) canvas.remove(); // without the QR maker, the link still prints
}

start();
