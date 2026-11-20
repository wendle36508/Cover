// gifts.js - the "My gifts" page (covergiving.com/gifts.html), where sponsors manage their own monthly gifts.
//   * Opened from a "Manage my gift" link (gifts.html?t=TOKEN). The token is moved out of the address bar
//     into this tab's memory right away, so it isn't left in history or shared screenshots.
//   * No link? The page asks for their email and sends one (with the same bot check as checkout).
//   * gifts.html?demo=1 shows sample gifts; nothing real is read or changed.
// Everything shown is set with textContent, never as HTML.

import { applyBrand, safeImageUrl } from "./brand.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, TURNSTILE_SITE_KEY } from "./config.js";
import {
  demoGifts, followLine, helpsLine, money, monthYear, pickToken, readDollars, shortDate, statusInfo, TOKEN_KEY,
} from "./gifts-logic.js";

const $ = (id) => document.getElementById(id);
const demo = new URLSearchParams(location.search).get("demo") === "1";
let token = "";
let data = null;
const open = new Map(); // gift id -> "amount" | "follow" | "cancel"
const notes = new Map(); // gift id -> { tone, text } shown on that gift
const receiptsOpen = new Set(); // gift ids whose past-gifts list is open (kept open when the page redraws)

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function show(...nodes) {
  $("content").replaceChildren(...nodes);
}

/** A photo address the page may show: https only (the demo also uses the site's own photos). */
function imageSrc(url) {
  return safeImageUrl(url) || (demo && /^photos\/[\w-]+\.jpg$/.test(url ?? "") ? url : "");
}

function photo(url, alt) {
  const src = imageSrc(url);
  if (!src) return el("div", "noimg");
  const img = el("img");
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  return img;
}

// ---------- Talking to Cover ----------

async function call(action, extra = {}) {
  if (demo) return demoCall(action, extra);
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/sponsor-portal`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ action, token, ...extra }),
    });
  } catch {
    throw new Error("We couldn't reach Cover. Check your connection and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (response.status === 403) forgetToken();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "Something went wrong. Please try again."), { status: response.status });
  return result;
}

/** The demo's pretend server: changes the sample data in memory. */
async function demoCall(action, extra) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (action === "overview") return data ?? demoGifts();
  if (action === "request_link") return { sent: true };
  const gift = data.gifts.find((g) => g.id === extra.sponsorId);
  if (action === "card") return { url: "#demo-card-form" };
  if (action === "amount") gift.monthlyCents = readDollars(extra.amount).cents;
  if (action === "follow") gift.following = gift.choices.find((c) => c.id === extra.itemId);
  if (action === "updates") gift.updatesOff = !extra.on;
  if (action === "wall") gift.onWall = extra.on;
  if (action === "cancel") Object.assign(gift, { status: "canceled", canChange: false, nextCharge: null });
  return {};
}

function forgetToken() {
  token = "";
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: nothing was saved anyway
  }
}

// ---------- Sign in (no link yet, or an old one) ----------

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileToken = "";

async function startTurnstile() {
  if (!TURNSTILE_SITE_KEY || demo) return;
  try {
    await new Promise((resolve, reject) => {
      if (globalThis.turnstile) return resolve();
      const script = el("script");
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The robot check didn't load."));
      document.head.append(script);
    });
    turnstileToken = "";
    globalThis.turnstile.render("#turnstile", {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (value) => (turnstileToken = value),
      "expired-callback": () => (turnstileToken = ""),
    });
  } catch (error) {
    console.warn(error);
  }
}

async function waitForTurnstile() {
  if (!TURNSTILE_SITE_KEY || demo) return "";
  for (let waited = 0; !turnstileToken && waited < 8000; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  return turnstileToken;
}

function showSignIn(message = "") {
  $("sign-out").hidden = true;
  const panel = el("section", "panel signin");
  const form = el("form");
  form.noValidate = true;
  const group = el("div", "field-group");
  const label = el("label", "", "Your email");
  label.htmlFor = "email";
  const input = el("input");
  Object.assign(input, { id: "email", type: "email", autocomplete: "email", required: true, placeholder: "you@email.com" });
  const error = el("p", "field-error");
  const bot = el("div", "turnstile");
  bot.id = "turnstile";
  const send = el("button", "btn btn-primary btn-block", "Email me a link");
  send.type = "submit";
  group.append(label, input, error);
  form.append(group, bot, send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      await call("request_link", { email: input.value, turnstileToken: await waitForTurnstile() });
      showLinkSent(input.value.trim());
    } catch (failure) {
      error.textContent = failure.message;
      send.disabled = false;
      send.textContent = "Email me a link";
      if (globalThis.turnstile) globalThis.turnstile.reset("#turnstile");
    }
  });
  panel.append(el("h1", "", "Manage your monthly gifts"),
    el("p", "lead", "Enter the email you give with and we'll send you a secure link. No password needed."));
  if (message) panel.append(el("p", "notice warn", message));
  form.style.marginTop = "20px";
  panel.append(form);
  show(panel);
  startTurnstile();
}

function showLinkSent(email) {
  const panel = el("section", "panel signin");
  panel.append(
    el("h1", "", "Check your email"),
    el("p", "lead", `If ${email} gives through Cover, a link to your gifts is on its way. It can take a minute, and it works for 60 days.`),
    button("Use a different email", "linklike", () => showSignIn()),
  );
  panel.lastChild.style.marginTop = "18px";
  show(panel);
}

// ---------- Your gifts ----------

function giftHead(gift) {
  const head = el("div", "gift-head");
  const org = el("div", "org");
  const initials = el("span", "brand-mark", gift.nonprofit.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""));
  const logo = imageSrc(gift.nonprofit.logo);
  if (logo) {
    const img = el("img", "brand-logo");
    img.src = logo;
    img.alt = "";
    org.append(img);
  } else {
    org.append(initials);
  }
  org.append(el("span", "", gift.nonprofit.name));
  const status = statusInfo(gift.status);
  head.append(org, el("span", `pill ${status.tone}`, status.label));
  return head;
}

function fact(label, value) {
  const box = el("div", "fact");
  box.append(el("small", "", label), el("b", "", value || "—"));
  return box;
}

function facts(gift) {
  const grid = el("div", "facts");
  grid.append(
    fact("Monthly gift", money(gift.monthlyCents)),
    fact(gift.canChange ? "Next gift" : "Status", gift.canChange ? shortDate(gift.nextCharge) : "No more charges"),
    fact("Card", gift.card ? gift.card.label.replace(" ending ", " ··") : gift.stripeReached ? "None on file" : "Couldn't load"),
    fact("Giving since", monthYear(gift.startedAt)),
  );
  return grid;
}

/** Open one of a gift's boxes ("amount", "follow", "cancel"), or close it with null. */
function setPanel(gift, name) {
  notes.delete(gift.id);
  if (name) open.set(gift.id, name);
  else open.delete(gift.id);
  drawGifts();
}

async function act(gift, action, extra, success) {
  notes.delete(gift.id);
  try {
    await call(action, { sponsorId: gift.id, ...extra });
    open.delete(gift.id);
    if (success) notes.set(gift.id, { tone: "ok", text: success });
    if (!demo) data = await call("overview");
  } catch (failure) {
    if (failure.status === 403) return showSignIn(failure.message);
    notes.set(gift.id, { tone: "bad", text: failure.message });
  }
  drawGifts();
}

async function updateCard(gift) {
  notes.delete(gift.id);
  try {
    const { url } = await call("card", { sponsorId: gift.id });
    if (demo) {
      notes.set(gift.id, { tone: "ok", text: "In the real page, this opens a secure card form, then comes back here." });
      return drawGifts();
    }
    location.href = url; // Stripe's secure card form, on the nonprofit's account; it comes back here
  } catch (failure) {
    if (failure.status === 403) return showSignIn(failure.message);
    notes.set(gift.id, { tone: "bad", text: failure.message });
    drawGifts();
  }
}

function amountBox(gift) {
  const box = el("div", "box");
  const row = el("form", "amount-row");
  const label = el("label");
  const input = el("input");
  Object.assign(input, { inputMode: "decimal", value: String(gift.monthlyCents / 100), ariaLabel: "New monthly amount in dollars" });
  label.append(input);
  const error = el("p", "error");
  const save = el("button", "btn btn-primary", "Save");
  save.type = "submit";
  row.append(label, save, button("Never mind", "linklike", () => setPanel(gift, null)));
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    const checked = readDollars(input.value);
    if (checked.error) {
      error.textContent = checked.error;
      return;
    }
    save.disabled = true;
    act(gift, "amount", { amount: input.value }, `Done. Your gift is now ${money(checked.cents)} a month, starting with your next gift.`);
  });
  box.append(el("h3", "", "Change your monthly gift"), el("p", "", "The new amount starts with your next gift. Nothing is charged today."), row, error);
  return box;
}

function followBox(gift) {
  const box = el("div", "box");
  const grid = el("div", "choices");
  for (const choice of gift.choices) {
    const card = button("", `choice${gift.following?.id === choice.id ? " current" : ""}`, () =>
      act(gift, "follow", { itemId: choice.id }, `You now follow ${choice.name}. Your gift still helps everyone at ${gift.nonprofit.name}.`));
    card.append(photo(choice.photoUrl, choice.name), el("b", "", choice.name));
    grid.append(card);
  }
  box.append(el("h3", "", "Who would you like to follow?"), el("p", "", `You'll get their updates. Your gift still goes to ${gift.nonprofit.name}'s general fund.`), grid,
    button("Never mind", "linklike", () => setPanel(gift, null)));
  box.lastChild.style.marginTop = "12px";
  return box;
}

function cancelBox(gift) {
  const box = el("div", "box");
  const row = el("div", "actions");
  row.append(
    button("Yes, cancel my gift", "btn btn-dark", () => act(gift, "cancel", {}, `Your gift to ${gift.nonprofit.name} is canceled. You won't be charged again. Thank you for everything you gave.`)),
    button("Keep my gift", "btn btn-ghost", () => setPanel(gift, null)),
  );
  box.append(el("h3", "", `Cancel your ${money(gift.monthlyCents)} monthly gift?`),
    el("p", "", `You won't be charged again. Nothing you've already given is refunded. You can always start again on ${gift.nonprofit.name}'s page.`), row);
  return box;
}

function switches(gift) {
  const wrap = el("div", "switches");
  const row = (text, checked, action, onText, offText) => {
    const label = el("label", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => act(gift, action, { on: input.checked }, input.checked ? onText : offText));
    label.append(el("span", "", text), input);
    return label;
  };
  wrap.append(
    row(`Email me updates${gift.following ? ` about ${gift.following.name}` : ""}`, !gift.updatesOff, "updates", "Updates are on.", "Updates are off. Your gift keeps going."),
    row("Show my first name on the thank-you wall", gift.onWall, "wall", "Your name is on the thank-you wall.", "Your name is off the thank-you wall."),
  );
  return wrap;
}

function payments(gift) {
  const list = el("details");
  list.open = receiptsOpen.has(gift.id);
  list.addEventListener("toggle", () => (list.open ? receiptsOpen.add(gift.id) : receiptsOpen.delete(gift.id)));
  list.append(el("summary", "", gift.payments.length ? `Past gifts and receipts (${gift.payments.length})` : "Past gifts and receipts"));
  if (!gift.payments.length) {
    list.append(el("p", "muted", gift.stripeReached ? "No gifts yet." : "We couldn't load your past gifts just now. Try again in a minute."));
    return list;
  }
  const table = el("table");
  for (const payment of gift.payments) {
    const tr = el("tr");
    const receipt = el("td");
    if (payment.receiptUrl) {
      const link = el("a", "", "Receipt");
      link.href = payment.receiptUrl;
      link.target = "_blank";
      link.rel = "noopener";
      receipt.append(link);
    }
    tr.append(el("td", "", shortDate(payment.date)), el("td", "", money(payment.amountCents)), el("td", payment.paid ? "muted" : "", payment.status), receipt);
    table.append(tr);
  }
  list.append(table);
  return list;
}

function giftCard(gift) {
  const card = el("article", "gift");
  applyBrand(card, gift.nonprofit.brandColor);
  const body = el("div", "gift-body");
  const follow = el("div", "follow");
  const words = el("div");
  words.append(el("h2", "", followLine(gift)), el("p", "", helpsLine(gift)));
  follow.append(photo(gift.following?.photoUrl, gift.following?.name ?? ""), words);
  body.append(follow, facts(gift));

  if (gift.status === "past_due") body.append(el("p", "notice warn", "Your last gift didn't go through. Update your card and we'll try again automatically."));
  const note = notes.get(gift.id);
  if (note) body.append(el("p", `notice ${note.tone}`, note.text));

  if (gift.canChange) {
    const actions = el("div", "actions");
    actions.append(
      button("Update card", `btn ${gift.status === "past_due" ? "btn-primary" : "btn-ghost"}`, () => updateCard(gift)),
      button("Change amount", "btn btn-ghost", () => setPanel(gift, "amount")),
    );
    if (gift.choices.length > 1 || (gift.choices.length === 1 && gift.following?.id !== gift.choices[0].id)) {
      actions.append(button(gift.nonprofit.kind === "animal" ? "Follow someone else" : "Follow something else", "btn btn-ghost", () => setPanel(gift, "follow")));
    }
    body.append(actions);
    const panel = { amount: amountBox, follow: followBox, cancel: cancelBox }[open.get(gift.id)];
    if (panel) body.append(panel(gift));
    body.append(switches(gift));
  }
  body.append(payments(gift));
  if (gift.canChange && open.get(gift.id) !== "cancel") {
    const cancel = button("Cancel this gift", "linklike", () => setPanel(gift, "cancel"));
    cancel.style.marginTop = "16px";
    body.append(cancel);
  }
  card.append(giftHead(gift), body);
  return card;
}

function drawGifts() {
  $("sign-out").hidden = demo;
  const heading = el("div");
  heading.append(el("h1", "", "Your gifts"), el("p", "lead", `Signed in as ${data.email}`));
  if (!data.gifts.length) {
    const empty = el("section", "panel");
    empty.append(el("h2", "", "No gifts yet"), el("p", "lead", "We couldn't find any monthly gifts for this email. If you give with a different email, sign out and use that one."));
    return show(heading, empty);
  }
  show(heading, ...data.gifts.map(giftCard));
}

// ---------- Start ----------

async function start() {
  $("sign-out").addEventListener("click", () => {
    forgetToken();
    data = null;
    showSignIn();
  });
  let stored = "";
  try {
    stored = sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    // storage blocked: the link still works for this visit
  }
  const picked = pickToken(location.search, stored);
  token = picked.token;
  if (picked.fromLink) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // storage blocked
    }
    history.replaceState(null, "", location.pathname);
  }
  if (!token && !demo) return showSignIn();
  try {
    data = await call("overview");
    drawGifts();
  } catch (failure) {
    if (failure.status === 403) return showSignIn(failure.message);
    show(el("h1", "", "That didn't work"), el("p", "notice bad", failure.message));
  }
}

start();
