// give.js - draws a nonprofit's sponsor page and runs the sponsor pop-up:
// form -> Stripe's secure card form (inside the pop-up) -> green check and thank-you note.
//
// Real nonprofits load from Cover's database (live.js) and take real payments through Stripe.
// The made-up demo nonprofits (orgs.js) run the same flow with no payment, saving to this browser only.
// Anything a visitor types is shown with textContent (never as HTML), so it can't inject code.

import { STRIPE_PUBLISHABLE_KEY } from "./config.js";
import { loadLiveOrg, startSponsorship } from "./live.js";
import { ORGS, SHARED_FAQ } from "./orgs.js";
import {
  buildRecord, money, percentCovered, publicName, sponsorLabel,
  thankYou, timeAgo, validateSponsor, withNewSponsor,
} from "./sponsor.js";
import { clearSponsors, saveSponsor, sponsorsFor } from "./store.js";

const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="5,12.5 10,17 19,7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const params = new URLSearchParams(location.search);
const requestedSlug = (params.get("org") ?? "rescue").toLowerCase();
if (params.has("reset")) clearSponsors();

const $ = (id) => document.getElementById(id);

/** A photo path: full links and paths are used as-is; short names point at the demo photos. */
function photoSrc(value) {
  if (!value) return "photos/dog-smile.jpg";
  return value.includes("/") || value.includes(":") ? value : `photos/${value}.jpg`;
}

let org;
let currentItem = null;
let pendingRecord = null;
let checkout = null; // Stripe's card form, while it's showing

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addChecks(root = document) {
  root.querySelectorAll("[data-check]").forEach((node) => (node.innerHTML = CHECK_SVG));
}

// ---------- Drawing the page ----------

function drawText() {
  document.title = `${org.cta} | ${org.name}`;
  document.querySelectorAll("[data-f]").forEach((node) => (node.textContent = org[node.dataset.f] ?? ""));
  $("hero-photo").src = photoSrc(org.heroPhotoWide ?? org.items[0]?.photo);
  $("hero-photo").alt = org.heroAlt ?? "";
  $("filters").replaceChildren(...(org.filters ?? []).map((name, i) => el("span", i === 0 ? "on" : "", name)));
  $("steps").replaceChildren(...org.steps.map(([title, text], i) => {
    const step = el("div", "step");
    step.append(el("div", "n", String(i + 1)), el("h3", "", title), el("p", "", text));
    return step;
  }));
  $("quote").replaceChildren(`"${org.quote[0]}`, el("em", "", org.quote[1]), '"');
  $("quote-by").textContent = `The ${org.name} team`;
  $("quote-photo").src = photoSrc(org.quotePhoto ?? org.items[1]?.photo ?? org.items[0]?.photo);
  $("quote-photo").alt = "";
  $("faq-list").replaceChildren(...[...(org.faq ?? []), ...SHARED_FAQ(org)].map(([q, a], i) => {
    const details = el("details");
    details.open = i === 0;
    details.append(el("summary", "", q), el("p", "", a));
    return details;
  }));
  $("foot").textContent = org.live ? `${org.name}${org.place ? ` · ${org.place}` : ""}` : `${org.name} · ${org.place} · Demo page with made-up content`;
}

function drawTotals() {
  const pct = percentCovered(org.covered, org.goal);
  $("pct").textContent = `${pct}%`;
  $("covered").textContent = money(org.covered);
  $("goal").textContent = `of ${money(org.goal)} covered`;
  $("bar").style.width = `${pct}%`;
  $("bar-wrap").setAttribute("aria-valuenow", String(pct));
}

/** The "Sarah sponsored Bella" notice. Hidden when there's nobody to show yet. */
function drawToast(latest) {
  const toast = $("toast");
  if (latest) {
    $("toast-a").textContent = `${latest.name} sponsored ${latest.item}`;
    $("toast-b").textContent = timeAgo(latest.when);
  } else if (!org.live && org.toast) {
    [$("toast-a").textContent, $("toast-b").textContent] = org.toast;
  } else {
    toast.hidden = true;
    return;
  }
  toast.hidden = false;
}

function latestFromRecord(record) {
  return record ? { name: publicName(record), item: record.itemName, when: record.createdAt } : null;
}

function itemCard(item) {
  const card = el("article", "card item");
  card.dataset.name = item.name;
  const img = el("img");
  img.src = photoSrc(item.photo);
  img.alt = item.name;
  const body = el("div", "body");
  const top = el("div", "top");
  top.append(el("h3", "", item.name));
  const foot = el("div", "foot");
  const button = el("button", "btn btn-dark", "Sponsor");
  button.type = "button";
  button.setAttribute("aria-label", `Sponsor ${item.name}`);
  button.addEventListener("click", () => openDialog(item.name));
  foot.append(el("span", "sponsors", sponsorLabel(item.sponsors)), button);
  body.append(top);
  if (item.badge) {
    const badge = el("span", `pill ${item.hot ? "green" : ""}`, item.badge);
    badge.style.marginTop = "10px";
    body.append(badge);
  }
  body.append(el("p", "", item.note), foot);
  card.append(img, body);
  return card;
}

function drawItems() {
  $("items").classList.toggle("four", org.items.length === 4);
  $("items").replaceChildren(...org.items.map(itemCard));
}

function drawAll(latest) {
  drawText();
  drawTotals();
  drawItems();
  drawToast(latest);
  addChecks();
}

// ---------- The sponsor pop-up ----------

const dialog = $("sponsor-dialog");
const form = $("step-form");

function showStep(id) {
  ["step-form", "step-pay", "step-done"].forEach((step) => ($(step).hidden = step !== id));
}

function clearErrors() {
  ["firstName", "email", "businessName"].forEach((field) => {
    $(`e-${field}`).textContent = "";
    form.elements[field].removeAttribute("aria-invalid");
  });
}

function removeCardForm() {
  checkout?.destroy();
  checkout = null;
  $("pay-mount").replaceChildren();
}

function openDialog(itemName) {
  currentItem = org.items.find((item) => item.name === itemName);
  if (!currentItem) return;
  pendingRecord = null;
  removeCardForm();
  form.reset();
  clearErrors();
  $("business-group").hidden = true;
  $("dialog-photo").src = photoSrc(currentItem.photo);
  $("dialog-photo").alt = currentItem.name;
  $("dialog-title").textContent = `Sponsor ${currentItem.name}`;
  $("dialog-sub").textContent = `${money(org.price)} a month · ${org.name}`;
  $("form-submit").textContent = `Continue to ${money(org.price)} a month`;
  $("form-submit").disabled = false;
  $("form-fine").textContent = `Your gift goes into one fund that helps ${org.everyone}. ${currentItem.name} is who you'll get updates from. Cancel anytime.`;
  showStep("step-form");
  dialog.showModal();
  form.elements.firstName.focus();
}

function closeDialog() {
  removeCardForm();
  dialog.close();
}

function showPayError(message) {
  $("pay-status").textContent = message;
  $("pay-status").classList.add("error");
  $("pay-status").hidden = false;
}

/** Real nonprofit: ask Cover's server for Stripe's card form and show it in the pop-up. */
async function showCardForm(values) {
  $("pay-live").hidden = false;
  $("pay-demo").hidden = true;
  $("pay-status").textContent = "Loading the secure payment form…";
  $("pay-status").classList.remove("error");
  $("pay-status").hidden = false;
  showStep("step-pay");
  if (!STRIPE_PUBLISHABLE_KEY || typeof globalThis.Stripe !== "function") {
    showPayError("Payments aren't switched on yet. Please check back soon.");
    return;
  }
  try {
    const { clientSecret, stripeAccount } = await startSponsorship({
      slug: org.slug,
      itemId: currentItem.id,
      firstName: values.firstName,
      email: values.email,
      showName: values.showName,
      isBusiness: values.isBusiness,
      businessName: values.businessName,
    });
    const stripe = globalThis.Stripe(STRIPE_PUBLISHABLE_KEY, { stripeAccount });
    const record = pendingRecord;
    checkout = await stripe.createEmbeddedCheckoutPage({
      fetchClientSecret: async () => clientSecret,
      onComplete: () => {
        removeCardForm();
        finishSponsor(record);
      },
    });
    $("pay-status").hidden = true;
    checkout.mount("#pay-mount");
  } catch (error) {
    showPayError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
  }
}

/** Demo page: no payment, just the button that finishes the demo. */
function showDemoStep() {
  $("pay-live").hidden = true;
  $("pay-demo").hidden = false;
  showStep("step-pay");
  $("pay-done").focus();
}

function showThankYou(record) {
  const note = thankYou(record, org, currentItem);
  $("thanks-title").textContent = note.title;
  $("thanks-body").textContent = note.body;
  $("thanks-sig").textContent = `— ${note.signedBy}`;
  $("done-fine").textContent = org.live
    ? `${org.name} will email your receipt to ${record.email}. You can cancel anytime from that email.`
    : `Demo only: no money moved. Updates would go to ${record.email}.`;
  const stamp = $("stamp");
  stamp.innerHTML = CHECK_SVG;
  stamp.classList.remove("thud");
  void stamp.offsetWidth; // restart the animation
  stamp.classList.add("thud");
  showStep("step-done");
  $("done-close").focus();
}

function celebrateOnPage(record) {
  org = withNewSponsor(org, record.itemName);
  drawTotals();
  drawItems();
  drawToast(latestFromRecord(record));
  const toast = $("toast");
  toast.classList.remove("pop");
  void toast.offsetWidth;
  toast.classList.add("pop");
  document.querySelector(`.item[data-name="${CSS.escape(record.itemName)}"]`)?.classList.add("just-joined");
}

function finishSponsor(record) {
  if (!record) return;
  if (!org.live) saveSponsor(record);
  celebrateOnPage(record);
  showThankYou(record);
  pendingRecord = null;
}

form.elements.isBusiness.addEventListener("change", (event) => {
  $("business-group").hidden = !event.target.checked;
  if (event.target.checked) form.elements.businessName.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearErrors();
  const result = validateSponsor({
    firstName: form.elements.firstName.value,
    email: form.elements.email.value,
    showName: form.elements.showName.checked,
    isBusiness: form.elements.isBusiness.checked,
    businessName: form.elements.businessName.value,
  });
  if (!result.ok) {
    Object.entries(result.errors).forEach(([field, message]) => {
      $(`e-${field}`).textContent = message;
      form.elements[field].setAttribute("aria-invalid", "true");
    });
    form.elements[Object.keys(result.errors)[0]].focus();
    return;
  }
  pendingRecord = buildRecord(result.values, org.slug, org, currentItem);
  if (org.live) showCardForm(result.values);
  else showDemoStep();
});

$("pay-done").addEventListener("click", () => finishSponsor(pendingRecord));
$("pay-back").addEventListener("click", () => {
  removeCardForm();
  showStep("step-form");
});
$("dialog-close").addEventListener("click", closeDialog);
$("done-close").addEventListener("click", closeDialog);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog(); // click on the dark backdrop
});

/** Coming back from a payment method that had to leave the page (like a bank app). */
function showReturnThanks() {
  currentItem = org.items[0];
  $("dialog-photo").src = photoSrc(currentItem?.photo);
  $("dialog-title").textContent = "Thank you!";
  $("dialog-sub").textContent = org.name;
  $("thanks-title").textContent = "Your sponsorship is on its way.";
  $("thanks-body").textContent = `We're confirming your gift with ${org.name}. Your receipt will arrive by email.`;
  $("thanks-sig").textContent = `— ${org.name}`;
  $("done-fine").textContent = "";
  $("stamp").innerHTML = CHECK_SVG;
  showStep("step-done");
  dialog.showModal();
}

// ---------- Start ----------

async function start() {
  let live = null;
  try {
    live = await loadLiveOrg(requestedSlug);
  } catch (error) {
    console.warn("Couldn't load the live page; showing the demo instead.", error);
  }
  if (live) {
    org = live;
    const latest = live.recent[0];
    drawAll(latest ? { name: latest.display_name, item: latest.item_name, when: latest.joined_at } : null);
    if (params.has("session_id")) showReturnThanks();
    return;
  }
  const demoKey = ORGS[requestedSlug] ? requestedSlug : "rescue";
  const saved = sponsorsFor(demoKey);
  org = { ...saved.reduce((current, record) => withNewSponsor(current, record.itemName), ORGS[demoKey]), slug: demoKey, live: false };
  drawAll(latestFromRecord(saved.at(-1)));
}

start();
