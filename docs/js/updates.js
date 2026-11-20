// updates.js - the page sponsors open from links in Cover's emails (updates.html?a=stop|pick&t=TOKEN).
//   a=stop -> turns off emails for this sponsorship right away (with an "undo"). The gift keeps going.
//   a=pick -> choose a different buddy to follow at the same nonprofit.
//   a=wall -> takes their name off the nonprofit's thank-you wall right away (with an "undo").
// No account needed: the signed token in the link says which sponsorship it is. Everything shown
// is set with textContent, never as HTML.

import { applyBrand, safeImageUrl } from "./brand.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const params = new URLSearchParams(location.search);
const action = params.get("a");
const token = params.get("t") ?? "";
const $ = (id) => document.getElementById(id);
let info = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function call(body) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/sponsor-email`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token }),
    });
  } catch {
    throw new Error("We couldn't reach Cover. Check your connection and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Something went wrong. Please try again.");
  return result;
}

/** "To change your card, amount or cancel, go to My gifts." with a link to the sponsor's My gifts page. */
function giftsLine() {
  const line = el("p", "", "To change your card or amount, or cancel, go to ");
  const link = el("a", "", "My gifts");
  link.href = "gifts.html";
  link.style.textDecoration = "underline";
  line.append(link, ".");
  return line;
}

function show(...nodes) {
  $("content").replaceChildren(...nodes);
}

function showError(message) {
  show(el("h1", "", "That didn't work"), el("p", "error", message));
}

function drawOrg() {
  const np = info.nonprofit;
  applyBrand(document.body, np.brandColor);
  $("org").hidden = false;
  $("org-name").textContent = np.name;
  $("org-initials").textContent = np.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const logo = safeImageUrl(np.logo);
  if (logo) {
    $("org-logo").src = logo;
    $("org-logo").hidden = false;
    $("org-initials").hidden = true;
  }
  document.title = `Your sponsorship | ${np.name}`;
}

const who = () => info.current?.name ?? info.nonprofit.name;

// ---------- stop updates ----------

async function stopUpdates() {
  await call({ action: "stop" });
  const undo = el("button", "btn btn-ghost", "Turn updates back on");
  undo.type = "button";
  undo.addEventListener("click", () => resumeUpdates().catch((e) => showError(e.message)));
  const actions = el("div", "actions");
  actions.append(undo);
  show(
    el("h1", "", "You won't get more updates"),
    el("p", "", `We've stopped emails about ${who()} from ${info.nonprofit.name}. Your monthly gift keeps going and still helps everyone there.`),
    giftsLine(),
    actions,
  );
}

async function resumeUpdates() {
  await call({ action: "resume" });
  show(el("h1", "", "Updates are back on"), el("p", "", `You'll hear about ${who()} again. Thanks for sticking with ${info.nonprofit.name}.`));
}

// ---------- the thank-you wall ----------

async function takeNameOff() {
  await call({ action: "wall_off" });
  const undo = el("button", "btn btn-ghost", "Put my name back");
  undo.type = "button";
  undo.addEventListener("click", () => putNameBack().catch((e) => showError(e.message)));
  const actions = el("div", "actions");
  actions.append(undo);
  show(
    el("h1", "", "Your name is off the thank-you wall"),
    el("p", "", `${info.nonprofit.name}'s page won't show your name anymore. Your monthly gift and your updates keep going.`),
    actions,
  );
}

async function putNameBack() {
  await call({ action: "wall_on" });
  show(el("h1", "", "Your name is back on the wall"), el("p", "", `Thanks for letting ${info.nonprofit.name} say thank you in public.`));
}

// ---------- pick a different buddy ----------

function drawPicker() {
  if (!info.canMove) {
    show(el("h1", "", "This sponsorship has ended"), el("p", "", `There's no one to follow on it anymore. Thank you for supporting ${info.nonprofit.name}.`));
    return;
  }
  if (!info.items.length) {
    show(el("h1", "", "No one to pick right now"), el("p", "", `${info.nonprofit.name} doesn't have anyone on their page at the moment, so you're following the whole ${info.nonprofit.kind === "animal" ? "rescue" : "nonprofit"}.`));
    return;
  }
  const grid = el("div", "choices");
  for (const item of info.items) {
    const button = el("button", `choice${item.id === info.current?.id ? " current" : ""}`);
    button.type = "button";
    const photo = safeImageUrl(item.photo_url);
    if (photo) {
      const img = el("img");
      img.src = photo;
      img.alt = "";
      img.style.objectPosition = `${Number(item.photo_focus_x ?? 50)}% ${Number(item.photo_focus_y ?? 38)}%`;
      button.append(img);
    } else {
      button.append(el("div", "noimg"));
    }
    button.append(el("b", "", item.name), el("span", "", item.id === info.current?.id ? "You follow them now" : "Follow"));
    button.addEventListener("click", () => pick(item).catch((e) => showError(e.message)));
    grid.append(button);
  }
  const stop = el("button", "", "Stop these updates");
  stop.type = "button";
  stop.addEventListener("click", () => stopUpdates().catch((e) => showError(e.message)));
  const footer = el("p", "small", "Don't want emails? ");
  footer.append(stop);
  show(
    el("h1", "", `Hi ${info.firstName}, who do you want to follow?`),
    el("p", "", `Your monthly gift helps everyone at ${info.nonprofit.name} either way. This just picks whose updates you get.`),
    grid,
    footer,
  );
}

async function pick(item) {
  const result = await call({ action: "move", itemId: item.id });
  info.current = result.current;
  show(
    el("h1", "", `You're now following ${result.current.name}`),
    el("p", "", `You'll get ${result.current.name}'s updates from here. Your gift still helps everyone at ${info.nonprofit.name}.`),
  );
}

async function start() {
  if (!token || !["stop", "pick", "wall"].includes(action)) {
    showError("This link is missing a piece. Open it straight from the email, or reply to the email for help.");
    return;
  }
  info = await call({ action: "lookup" });
  drawOrg();
  if (action === "stop") await stopUpdates();
  else if (action === "wall") await takeNameOff();
  else drawPicker();
}

start().catch((error) => showError(error.message));
