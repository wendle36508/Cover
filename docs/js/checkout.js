// checkout.js - the new checkout pop-up on the new sponsor pages (phase 3, Nov 23, 2026).
// Any amount from $5; Monthly (picked first), Yearly or One time; for me or (from phase 4) as a gift;
// Cover's 3% fee line and "cover it" box only when the fee is switched on for this nonprofit.
// Then the same robot check and Stripe card form as today's checkout, on the nonprofit's own account.
// The server checks everything again (create-sponsorship).

import { buttonText, dollars, frequency, frequencyNote, FREQUENCIES, GIFTS_READY, latestGiftDay, readAmount, todayIso } from "./checkout-logic.js";
import { STRIPE_PUBLISHABLE_KEY, TURNSTILE_SITE_KEY } from "./config.js";
import { coveredTotalCents, formatCents } from "./fees.js";
import { startSponsorship } from "./live.js";
import { midSentence, validateSponsor } from "./sponsor.js";

const $ = (id) => document.getElementById(id);
const state = { org: null, item: null, interval: "month", forGift: false, checkout: null };

// ---------- robot check (same as today's checkout) ----------

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileWidget = null;
let turnstileToken = "";
let turnstileLoading = null;

function loadTurnstile() {
  turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("The robot check didn't load."));
    document.head.append(script);
  });
  return turnstileLoading;
}

async function startTurnstile() {
  if (!TURNSTILE_SITE_KEY) return;
  try {
    await loadTurnstile();
    turnstileToken = "";
    if (turnstileWidget !== null) return globalThis.turnstile.reset(turnstileWidget);
    turnstileWidget = globalThis.turnstile.render("#co-turnstile", {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => (turnstileToken = token),
      "expired-callback": () => (turnstileToken = ""),
    });
  } catch (error) {
    console.warn(error);
  }
}

async function takeTurnstileToken() {
  if (!TURNSTILE_SITE_KEY) return "";
  for (let waited = 0; !turnstileToken && waited < 8000; waited += 250) await new Promise((r) => setTimeout(r, 250));
  const token = turnstileToken;
  turnstileToken = "";
  if (turnstileWidget !== null) globalThis.turnstile?.reset(turnstileWidget);
  return token;
}

// ---------- the form ----------

function step(id) {
  for (const s of ["co-form", "co-pay", "co-done"]) $(s).hidden = s !== id;
}

/** The amount the donor typed (cents), or null while it's empty or not right yet. */
function typedCents() {
  const read = readAmount($("co-amount").value, state.interval);
  return read.cents ?? null;
}

function chargedCents() {
  const cents = typedCents();
  if (cents === null) return null;
  return state.org.feeOn && $("co-cover-fee").checked ? coveredTotalCents(cents) : cents;
}

/** Everything that changes as they type or tap: labels, fee line, button, the wall box. */
function redraw() {
  const f = frequency(state.interval);
  for (const button of $("co-freq").children) button.setAttribute("aria-pressed", String(button.dataset.key === state.interval));
  $("co-amount-label").textContent = state.interval === "once" ? "How much" : `How much ${f.per}`;
  $("co-per").textContent = f.per;
  $("co-amount-note").textContent = frequencyNote(state.interval, state.item.name);
  const cents = typedCents();
  $("co-fee").hidden = !state.org.feeOn;
  if (state.org.feeOn) {
    const extra = cents ? coveredTotalCents(cents) - cents : null;
    $("co-cover-text").textContent = extra ? `Add ${formatCents(extra)} so ${state.org.name} gets your full gift` : `Add 3% so ${state.org.name} gets your full gift`;
  }
  for (const button of $("co-who").children) button.setAttribute("aria-pressed", String((button.dataset.key === "gift") === state.forGift));
  $("co-gift").hidden = !state.forGift;
  // Only ongoing sponsors show on the thank-you wall.
  $("co-wall-row").hidden = state.interval === "once";
  $("co-submit").textContent = buttonText(chargedCents(), state.interval);
  $("co-fine").textContent = `Every gift goes into one fund for ${midSentence(state.org.everyone)}.${state.interval === "once" ? "" : " Cancel anytime."}`;
}

function drawChoices() {
  $("co-freq").replaceChildren(...FREQUENCIES.map((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = f.key;
    b.textContent = f.label;
    b.addEventListener("click", () => {
      state.interval = f.key;
      $("co-amount-error").textContent = "";
      redraw();
    });
    return b;
  }));
  $("co-who-wrap").hidden = !GIFTS_READY;
  for (const button of $("co-who").children) {
    button.onclick = () => {
      state.forGift = button.dataset.key === "gift";
      redraw();
    };
  }
}

/** Open the checkout for one dog, group or program. */
export function openCheckout(org, item) {
  state.org = org;
  state.item = item;
  state.interval = "month"; // Monthly is picked first (Tanner)
  state.forGift = false;
  removeCardForm();
  $("co-form").reset();
  for (const e of document.querySelectorAll("#co-form .field-error")) e.textContent = "";
  $("co-photo").src = item.photo || "photos/dog-smile.jpg";
  $("co-photo").style.objectPosition = item.focus ?? "";
  $("co-title").textContent = `Sponsor ${item.name}`;
  $("co-sub").textContent = org.name;
  $("co-send-on").min = todayIso();
  $("co-send-on").max = latestGiftDay();
  $("co-send-on").value = todayIso();
  drawChoices();
  redraw();
  step("co-form");
  $("checkout").showModal();
  $("co-amount").focus();
  startTurnstile();
}

function readForm() {
  const form = $("co-form");
  const values = {
    firstName: form.elements.firstName.value,
    email: form.elements.email.value,
    showName: state.interval !== "once" && form.elements.showName.checked,
    lastInitial: form.elements.lastInitial?.value ?? "",
    isBusiness: form.elements.isBusiness.checked,
    businessName: form.elements.businessName.value,
  };
  return values;
}

async function submit(event) {
  event.preventDefault();
  const amount = readAmount($("co-amount").value, state.interval);
  $("co-amount-error").textContent = amount.error ?? "";
  const values = readForm();
  const checked = validateSponsor(values);
  for (const [key, message] of Object.entries({ firstName: "", email: "", businessName: "", ...checked.errors })) {
    const box = $(`co-e-${key}`);
    if (box) box.textContent = message;
  }
  let gift = null;
  if (state.forGift) {
    gift = { name: $("co-gift-name").value.trim(), email: $("co-gift-email").value.trim(), message: $("co-gift-message").value.trim(), sendOn: $("co-send-on").value };
    $("co-e-gift").textContent = !gift.name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(gift.email) ? "Add their name and email." : "";
  }
  if (amount.error || !checked.ok || $("co-e-gift").textContent) return;
  await pay({ ...checked.values, amountCents: amount.cents, gift });
}

// ---------- paying (Stripe's secure card form, inside the pop-up) ----------

function removeCardForm() {
  state.checkout?.destroy?.();
  state.checkout = null;
  $("co-pay-mount").replaceChildren();
}

function payError(message) {
  $("co-pay-status").textContent = message;
  $("co-pay-status").classList.add("error");
  $("co-pay-status").hidden = false;
}

async function pay(values) {
  step("co-pay");
  $("co-pay-status").textContent = "Loading the secure payment form…";
  $("co-pay-status").classList.remove("error");
  $("co-pay-status").hidden = false;
  if (!STRIPE_PUBLISHABLE_KEY || typeof globalThis.Stripe !== "function") return payError("Payments aren't switched on yet. Please check back soon.");
  try {
    const { clientSecret, stripeAccount } = await startSponsorship({
      slug: state.org.slug,
      itemId: state.item.id,
      firstName: values.firstName,
      email: values.email,
      showName: values.showName,
      lastInitial: values.lastInitial,
      isBusiness: values.isBusiness,
      businessName: values.businessName,
      amountCents: values.amountCents,
      interval: state.interval,
      gift: values.gift,
      coverFee: state.org.feeOn === true && $("co-cover-fee").checked,
      returnTo: "sponsor",
      turnstileToken: await takeTurnstileToken(),
    });
    const stripe = globalThis.Stripe(STRIPE_PUBLISHABLE_KEY, { stripeAccount });
    state.checkout = await stripe.createEmbeddedCheckoutPage({
      fetchClientSecret: () => Promise.resolve(clientSecret),
      onComplete: () => {
        removeCardForm();
        showThanks(values);
      },
    });
    $("co-pay-status").hidden = true;
    state.checkout.mount("#co-pay-mount");
  } catch (error) {
    payError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
  }
}

function showThanks(values) {
  step("co-done");
  $("co-thanks-title").textContent = `Thank you, ${values.firstName}!`;
  $("co-thanks-body").textContent = state.org.thanks
    ? String(state.org.thanks)
    : `Your gift helps ${state.item.name} and ${midSentence(state.org.everyone)}.`;
  $("co-thanks-sig").textContent = `— ${state.org.name}`;
  const charged = values.amountCents;
  $("co-done-fine").textContent = state.interval === "once"
    ? `${state.org.name} will email your receipt for ${dollars(charged)} to ${values.email}.`
    : `${state.org.name} will email your receipt to ${values.email}. You can change or cancel anytime at covergiving.com/gifts.html.`;
}

/** Coming back from a payment method that had to leave the page (like a bank app). */
export function showReturnThanks(org) {
  state.org = org;
  step("co-done");
  $("co-title").textContent = "Thank you!";
  $("co-sub").textContent = org.name;
  $("co-photo").src = org.items[0]?.photo || "photos/dog-smile.jpg";
  $("co-thanks-title").textContent = "Your gift is on its way.";
  $("co-thanks-body").textContent = `We're confirming it with ${org.name}. Your receipt will arrive by email.`;
  $("co-thanks-sig").textContent = `— ${org.name}`;
  $("co-done-fine").textContent = "";
  $("checkout").showModal();
}

// ---------- wiring ----------

export function setUpCheckout() {
  $("co-form").addEventListener("submit", submit);
  $("co-amount").addEventListener("input", () => {
    $("co-amount-error").textContent = "";
    redraw();
  });
  $("co-cover-fee").addEventListener("change", redraw);
  $("co-is-business").addEventListener("change", (e) => ($("co-business-group").hidden = !e.target.checked));
  $("co-show-name").addEventListener("change", (e) => ($("co-initial-group").hidden = !e.target.checked));
  $("co-close").addEventListener("click", () => {
    removeCardForm();
    $("checkout").close();
  });
  $("co-back").addEventListener("click", () => {
    removeCardForm();
    step("co-form");
  });
  $("co-done-close").addEventListener("click", () => $("checkout").close());
}
