// gifts.js - the "My sponsorships" page (covergiving.com/gifts.html): everyone a sponsor supports, the updates
// about them, their certificates and receipts, and managing each gift (approved mockup, Nov 25, 2026).
//   * Opened from a "Manage my gift" link (gifts.html?t=TOKEN). The token is moved out of the address bar
//     into this tab's memory right away, so it isn't left in history or shared screenshots.
//   * No link? The page asks for their email and sends one (with the same bot check as checkout).
//   * gifts.html?demo=1 shows sample gifts; nothing real is read or changed.
// Everything shown is set with textContent, never as HTML.

import { applyBrand, safeImageUrl } from "./brand.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, TURNSTILE_SITE_KEY } from "./config.js";
import {
  amountLabel, demoGifts, giftName, money, monthYear, paymentsFeed, pickToken, readDollars, shortDate, statusInfo, summaryLine, togetherLabel, TOKEN_KEY,
  updatesFeed,
} from "./gifts-logic.js";
import { itemSlug } from "./sponsor.js";

const $ = (id) => document.getElementById(id);
const demo = new URLSearchParams(location.search).get("demo") === "1";
let token = "";
let data = null;
const open = new Map(); // gift id -> "amount" | "follow" | "cancel"
const notes = new Map(); // gift id -> { tone, text } shown on that gift

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
  if (action === "amount") gift.monthlyCents = gift.giftCents = readDollars(extra.amount).cents;
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
  const label = el("label", "", "The email you give with");
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
  panel.append(el("h1", "", "Sign in to My sponsorships"),
    el("p", "lead", "Everyone you sponsor, their updates, your certificates and receipts. Enter the email you give with and we'll send you a secure link. No password needed."));
  if (message) panel.append(el("p", "notice warn", message));
  form.style.marginTop = "20px";
  panel.append(form);
  // The one bridge across: owners sign in somewhere else.
  const owner = el("p", "small", "Run a nonprofit? ");
  const ownerLink = el("a", "", "Owner sign-in");
  ownerLink.href = "signin.html";
  owner.append(ownerLink, " is here.");
  owner.style.marginTop = "16px";
  panel.append(owner);
  show(panel);
  startTurnstile();
}

function showLinkSent(email) {
  const panel = el("section", "panel signin");
  panel.append(
    el("h1", "", "Check your email"),
    el("p", "lead", `If ${email} gives through Cover, a link to your sponsorships is on its way. It can take a minute, and it works for 60 days.`),
    button("Use a different email", "linklike", () => showSignIn()),
  );
  panel.lastChild.style.marginTop = "18px";
  show(panel);
}

// ---------- My sponsorships ----------

const managing = new Set(); // gift ids whose "Manage gift" section is open

/** A photo cropped around the owner's chosen focus point (or a plain tile when there's none). */
function focusedPhoto(url, alt, focus) {
  const node = photo(url, alt);
  if (focus && node.tagName === "IMG") node.style.objectPosition = focus;
  return node;
}

/** The dog's (or program's) own page on the nonprofit's sponsor page. */
function profileLink(gift) {
  const params = new URLSearchParams({ org: gift.nonprofit.slug });
  if (gift.following) params.set("dog", itemSlug(gift.following.name));
  return `give.html?${params}`;
}

function linkTo(text, href, newTab = false) {
  const a = el("a", "textlink", text);
  a.href = href;
  if (newTab) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
}

function factPair(value, label) {
  const box = el("div");
  box.append(el("b", "", value), el("span", "", label));
  return box;
}

/** One card per sponsorship: photo, who, time together, amount, updates, and its links. */
function teamCard(gift) {
  const card = el("article", "one");
  const name = giftName(gift);
  const words = el("div", "w");
  const org = el("span", "org", gift.nonprofit.name);
  const status = statusInfo(gift.status);
  if (gift.status === "past_due") org.append(el("span", "pill warn", status.label));
  if (!gift.canChange) org.append(el("span", "pill ended", "Ended"));
  const facts = el("div", "facts");
  const count = gift.updates?.length ?? 0;
  facts.append(
    factPair(togetherLabel(gift.startedAt) || "New", "together"),
    factPair(money(gift.giftCents ?? gift.monthlyCents), gift.interval === "year" ? "a year" : "a month"),
    factPair(String(count), count === 1 ? "update" : "updates"),
  );
  const links = el("div", "links");
  if (gift.certificateUrl) links.append(linkTo("Certificate", gift.certificateUrl, true));
  if (gift.canChange) {
    const manage = button(managing.has(gift.id) ? "Close" : "Manage gift", "textlink", () => {
      if (managing.has(gift.id)) managing.delete(gift.id);
      else managing.add(gift.id);
      drawGifts();
      if (managing.has(gift.id)) document.getElementById(`manage-${gift.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    links.append(manage);
  }
  if (gift.nonprofit.slug) links.append(linkTo(gift.following ? `${gift.following.name}'s page` : "Their page", profileLink(gift)));
  words.append(el("h3", "", name), org, facts);
  if (gift.status === "past_due") words.append(el("p", "notice warn", "Your last gift didn't go through. Open Manage gift to update your card."));
  words.append(links);
  card.append(focusedPhoto(gift.following?.photoUrl, name, gift.following?.focus), words);
  return card;
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
  const per = gift.interval === "year" ? "year" : "month";
  Object.assign(input, { inputMode: "decimal", value: String((gift.giftCents ?? gift.monthlyCents) / 100), ariaLabel: `New ${per}ly amount in dollars` });
  label.append(input);
  const error = el("p", "error");
  const save = el("button", "btn btn-primary", "Save");
  save.type = "submit";
  row.append(label, save, button("Never mind", "linklike", () => setPanel(gift, null)));
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    const checked = per === "month" ? readDollars(input.value) : { cents: Math.round(Number(String(input.value).replace(/^\$/, "")) * 100) };
    if (checked.error || !(checked.cents > 0)) {
      error.textContent = checked.error ?? "Type an amount in dollars.";
      return;
    }
    save.disabled = true;
    act(gift, "amount", { amount: input.value }, `Done. Your gift is now ${money(checked.cents)} a ${per}, starting with your next gift.`);
  });
  const covers = gift.coversFee ? ` You chose to cover Cover's fee, so ${gift.nonprofit.name} gets the full amount; that stays on.` : "";
  box.append(el("h3", "", `Change your ${per}ly gift`), el("p", "", `The new amount starts with your next gift. Nothing is charged today.${covers}`), row, error);
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
  const done = button("Never mind", "linklike", () => setPanel(gift, null));
  done.style.marginTop = "16px";
  box.append(el("h3", "", "Who would you like to follow?"), el("p", "", `You'll get their updates. Your gift still goes to ${gift.nonprofit.name}'s general fund.`), grid, done);
  return box;
}

function cancelBox(gift) {
  const box = el("div", "box");
  const row = el("div", "actions");
  row.append(
    button("Yes, cancel my gift", "btn btn-dark", () => act(gift, "cancel", {}, `Your gift to ${gift.nonprofit.name} is canceled. You won't be charged again. Thank you for everything you gave.`)),
    button("Keep my gift", "btn btn-ghost", () => setPanel(gift, null)),
  );
  box.append(el("h3", "", `Cancel your ${amountLabel(gift)} gift?`),
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

function manageFact(label, value) {
  const box = el("div");
  box.append(el("small", "", label), el("b", "", value || "None"));
  return box;
}

/** Everything they can change about one gift: card, amount, who they follow, emails, the wall, cancel. */
function manageSection(gift) {
  const section = el("section", "manage");
  section.id = `manage-${gift.id}`;
  const head = el("div", "manage-head");
  head.append(el("h3", "", `Your gift for ${giftName(gift)}`), button("Close", "linklike", () => {
    managing.delete(gift.id);
    drawGifts();
  }));
  const grid = el("div", "grid");
  const per = gift.interval === "year" ? "Yearly gift" : "Monthly gift";
  grid.append(
    manageFact(per, gift.coversFee ? `${money(gift.monthlyCents)} (${money(gift.giftCents)} + fee)` : money(gift.monthlyCents)),
    manageFact("Next gift", shortDate(gift.nextCharge)),
    manageFact("Card", gift.card ? gift.card.label : gift.stripeReached ? "None on file" : "Couldn't load"),
    manageFact("Giving since", monthYear(gift.startedAt)),
  );
  section.append(head, grid);
  const note = notes.get(gift.id);
  if (note) section.append(el("p", `notice ${note.tone}`, note.text));
  const actions = el("div", "actions");
  actions.append(
    button("Update card", `btn ${gift.status === "past_due" ? "btn-primary" : "btn-ghost"}`, () => updateCard(gift)),
    button("Change amount", "btn btn-ghost", () => setPanel(gift, "amount")),
  );
  if (gift.choices.length > 1 || (gift.choices.length === 1 && gift.following?.id !== gift.choices[0].id)) {
    actions.append(button(gift.nonprofit.kind === "animal" ? "Follow someone else" : "Follow something else", "btn btn-ghost", () => setPanel(gift, "follow")));
  }
  section.append(actions);
  const panel = { amount: amountBox, follow: followBox, cancel: cancelBox }[open.get(gift.id)];
  if (panel) section.append(panel(gift));
  section.append(switches(gift));
  if (open.get(gift.id) !== "cancel") {
    const cancel = button("Cancel this gift", "linklike", () => setPanel(gift, "cancel"));
    cancel.style.marginTop = "16px";
    section.append(cancel);
  }
  return section;
}

/** "The latest from your team": every update about who they sponsor, newest first. */
function feedSection() {
  const section = el("section");
  section.style.paddingBottom = "0";
  const h2 = el("h2", "", "The latest from ");
  h2.append(el("span", "accent", "your team."));
  section.append(el("span", "label", "Updates"), h2);
  const posts = updatesFeed(data.gifts);
  if (!posts.length) {
    section.append(el("p", "quiet", "No updates yet. When a nonprofit sends one, it shows up here and in your email."));
    return section;
  }
  const feed = el("div", "feed");
  for (const post of posts) {
    const row = el("div", "post");
    const words = el("div");
    words.append(el("div", "who", `${post.name}, ${post.org}`), el("p", "", `"${post.text}"`), el("div", "when", shortDate(post.date)));
    row.append(photo(post.photoUrl || post.fallbackPhoto, post.name), words);
    feed.append(row);
  }
  section.append(feed);
  return section;
}

/** Certificates to keep or print, and every gift with its receipt. */
function keepSection() {
  const section = el("section");
  section.style.paddingBottom = "0";
  const two = el("div", "two");
  const left = el("div");
  left.append(el("span", "label", "Certificates"), el("h3", "", "Keep or print them."));
  const certs = el("div", "certs");
  for (const gift of data.gifts.filter((g) => g.certificateUrl)) {
    const card = el("a", "cert");
    card.href = gift.certificateUrl;
    card.target = "_blank";
    card.rel = "noopener";
    card.append(focusedPhoto(gift.following?.photoUrl, "", gift.following?.focus), el("i", "", gift.holderName || data.firstName || ""),
      el("span", "", `sponsors ${giftName(gift)}`));
    certs.append(card);
  }
  if (certs.children.length) left.append(certs);
  else left.append(el("p", "quiet", "Your certificates show up here once your first gift goes through."));

  const right = el("div");
  right.append(el("span", "label", "Receipts and history"), el("h3", "", "Every gift, in one place."));
  const rows = paymentsFeed(data.gifts);
  if (!rows.length) {
    const reached = data.gifts.every((g) => g.stripeReached || !g.canChange);
    right.append(el("p", "quiet", reached ? "No payments yet." : "We couldn't load your payments just now. Try again in a minute."));
  } else {
    const table = el("table");
    const head = el("tr");
    for (const title of ["Date", "For", "Amount", "Receipt"]) head.append(el("th", "", title));
    table.append(head);
    for (const payment of rows) {
      const tr = el("tr");
      const receipt = el("td");
      if (payment.receiptUrl) {
        const link = el("a", "", "View");
        link.href = payment.receiptUrl;
        link.target = "_blank";
        link.rel = "noopener";
        receipt.append(link);
      } else if (!payment.paid) {
        receipt.textContent = payment.status;
      }
      tr.append(el("td", "", shortDate(payment.date)), el("td", "", payment.name), el("td", "", money(payment.amountCents)), receipt);
      table.append(tr);
    }
    right.append(table);
  }
  two.append(left, right);
  section.append(two);
  return section;
}

function drawGifts() {
  $("sign-out").hidden = demo;
  const hello = el("section", "hello");
  const h1 = el("h1", "", `Hi${data.firstName ? ` ${data.firstName}` : ""}, `);
  h1.append(el("span", "accent", "here's your team."));
  hello.append(el("span", "label", "My sponsorships"), h1, el("p", "lead", summaryLine(data.gifts)), el("p", "signed", `Signed in as ${data.email}`));
  if (!data.gifts.length) {
    hello.querySelector(".lead").textContent = "We couldn't find any sponsorships for this email. If you give with a different email, sign out and use that one.";
    const find = linkTo("Find someone to sponsor", "index.html#nonprofits");
    find.className = "btn btn-moss";
    find.style.marginTop = "32px";
    hello.append(find);
    return show(hello);
  }
  // Each gift's "Manage gift" controls open right under its own card (full width).
  const mine = el("div", "mine");
  for (const gift of data.gifts) {
    mine.append(teamCard(gift));
    if (gift.canChange && managing.has(gift.id)) mine.append(manageSection(gift));
  }
  show(hello, mine, feedSection(), keepSection());
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
    const panel = el("section", "panel signin");
    panel.append(el("h1", "", "That didn't work"), el("p", "notice bad", failure.message));
    show(panel);
  }
}

start();
