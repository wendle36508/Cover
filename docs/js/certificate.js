// certificate.js - the sponsor's photo certificate (certificate.html?t=TOKEN), linked from their welcome
// or gift email. The signed token says which sponsorship it is; no account needed. Everything shown is
// set with textContent, never as HTML.

import { applyBrand, safeImageUrl } from "./brand.js";
import { certificateWords } from "./certificate-logic.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const token = new URLSearchParams(location.search).get("t") ?? "";
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function loadCertificate() {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/sponsor-email`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "certificate", token }),
    });
  } catch {
    throw new Error("We couldn't reach Cover. Check your connection and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Something went wrong. Please try again.");
  return result;
}

function orgLine(view) {
  const org = el("div", "org");
  const logo = safeImageUrl(view.logo);
  if (logo) {
    const img = el("img");
    img.src = logo;
    img.alt = "";
    org.append(img);
  }
  org.append(el("span", "", view.orgName));
  return org;
}

function draw(view) {
  const words = certificateWords(view);
  applyBrand(document.body, view.brandColor);
  document.title = `${words.title} | ${view.orgName}`;

  const sheet = el("article", "sheet");
  const photoUrl = safeImageUrl(view.photoUrl);
  const photo = el(photoUrl ? "img" : "div", "photo");
  if (photoUrl) {
    photo.src = photoUrl;
    photo.alt = view.itemName;
    photo.style.objectPosition = view.focus;
  }

  const side = el("div", "words");
  side.append(orgLine(view), el("p", "title", words.title), el("p", "intro", words.intro), el("h1", "holder", words.holder),
    el("div", "rule"), el("p", "line", words.line));
  if (words.date) side.append(el("p", "date", words.date));
  if (words.gift) side.append(el("p", "gift", words.gift));
  side.append(el("p", "thanks", `Thank you from all of us at ${view.orgName}.`));
  const foot = el("p", "foot", "Powered by");
  const mark = el("img");
  mark.src = "brand/logo.png";
  mark.alt = "Cover";
  foot.append(mark);
  side.append(foot);

  sheet.append(photo, side);
  $("certificate").replaceChildren(sheet);
  $("tools").hidden = false;
}

$("print").addEventListener("click", () => window.print());

if (!token) {
  $("certificate").replaceChildren(el("p", "problem", "This link is missing its code. Open the link in your email again."));
} else {
  loadCertificate().then(draw).catch((error) => {
    $("certificate").replaceChildren(el("p", "problem", error.message));
  });
}
