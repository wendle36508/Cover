// sponsor-page.js - the new sponsor pages (sponsor.html), phase 1 of the Dogs Trust-style rebuild:
//   sponsor.html?org=lucky-pup-rescue            the home page
//   sponsor.html?org=lucky-pup-rescue&view=all   the browse list (filters and sorting)
//   sponsor.html?org=lucky-pup-rescue&dog=burt   one profile (a dog, a group or a program)
// Everything a nonprofit typed is shown as plain text (textContent), never as HTML.
// Until the new checkout (phase 3), the Sponsor buttons open the current checkout on give.html.

import { applyBrand, safeImageUrl } from "./brand.js";
import { openCheckout, setUpCheckout, showReturnThanks } from "./checkout.js";
import { iconSvg } from "./icons.js";
import { loadLiveOrg } from "./live.js";
import { shareLink } from "./share.js";
import { browseList, factChips, filterOptions, profileHeading, profileLabels, readView, SORTS, viewLink } from "./sponsor-page-logic.js";
import { midSentence, storyParagraphs } from "./sponsor.js";
import { faqList, pageSettings, receiveList } from "./templates.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
let org = null;
let settings = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function link(className, text, href) {
  const a = el("a", className, text);
  a.href = href;
  return a;
}

function photoOf(item) {
  const img = el("img");
  img.src = item.photo || "photos/dog-smile.jpg";
  img.alt = item.name;
  img.loading = "lazy";
  if (item.focus) img.style.objectPosition = item.focus;
  return img;
}

/** The Sponsor button: opens the new checkout (any amount; Monthly, Yearly or One time). */
function sponsorButton(item, className) {
  const b = el("button", className, `Sponsor ${item.name}`);
  b.type = "button";
  b.addEventListener("click", () => openCheckout(org, item));
  return b;
}


function section(className, ...children) {
  const s = el("section", `sp-section ${className ?? ""}`.trim());
  const c = el("div", "container");
  c.append(...children);
  s.append(c);
  return s;
}

function heading(eyebrow, title, lead) {
  const box = el("div");
  box.append(el("div", "sp-eyebrow", eyebrow), el("h2", "sp-h2", title));
  if (lead) box.append(el("p", "sp-lead", lead));
  return box;
}

function helpsGrid(helps, four = false) {
  const grid = el("div", `sp-helps${four ? " four" : ""}`);
  for (const help of helps) {
    const card = el("div", "sp-help");
    const icon = el("span", "ic");
    icon.innerHTML = iconSvg(help.icon); // one of Cover's own fixed icons, never typed text
    card.append(icon, el("b", "", help.title));
    if (help.text) card.append(el("span", "", help.text));
    grid.append(card);
  }
  return grid;
}

function ticks(lines) {
  const list = el("ul", "sp-ticks");
  list.append(...lines.map((line) => el("li", "", line)));
  return list;
}

// ---------- top bar ----------

function drawChrome(page) {
  document.title = `Sponsor a ${settings.one} | ${org.name}`;
  applyBrand(document.body, org.brandColor);
  $("org-link").href = viewLink(org.slug, "home");
  $("org-name").textContent = org.name;
  $("foot-name").textContent = org.name;
  const logo = safeImageUrl(org.logo);
  $("org-logo").hidden = !logo;
  if (logo) $("org-logo").src = logo;
  $("org-initials").hidden = Boolean(logo);
  $("org-initials").textContent = org.initials ?? "";
  const links = [
    [`Sponsor a ${settings.one}`, viewLink(org.slug, "home"), page === "home"],
    [`Our ${settings.follow.toLowerCase()}`, viewLink(org.slug, "browse"), page === "browse"],
    ["How it works", `${viewLink(org.slug, "home")}#how`, false],
    ["Questions", `${viewLink(org.slug, "home")}#questions`, false],
  ];
  $("nav-links").replaceChildren(...links.map(([text, href, current]) => {
    const a = link("", text, href);
    if (current) a.setAttribute("aria-current", "page");
    return a;
  }));
  $("nav-cta").textContent = `Sponsor a ${settings.one}`;
  $("nav-cta").href = viewLink(org.slug, "browse");
}

// ---------- home page ----------

function drawHome() {
  const main = el("div");
  const hero = el("div", "container");
  const heroGrid = el("div", "sp-hero");
  const words = el("div");
  words.append(el("div", "sp-eyebrow", org.name), el("h1", "", `Sponsor a ${settings.one}`));
  const price = el("p", "sp-price");
  price.append(el("b", "", "Any amount"), ", monthly or one time");
  words.append(price, link("btn btn-primary btn-lg", `Choose a ${settings.one} to sponsor`, viewLink(org.slug, "browse")));
  const heroImg = el("img");
  heroImg.src = safeImageUrl(org.heroPhotoWide) || org.items[0]?.photo || "photos/dog-smile.jpg";
  heroImg.alt = "";
  heroGrid.append(words, heroImg);
  hero.append(heroGrid);
  main.append(hero);

  if (settings.stats.length) {
    const stats = el("div", "sp-stats");
    stats.append(...settings.stats.map((s) => {
      const box = el("div", "sp-stat");
      box.append(el("b", "", s.value), el("span", "", s.label));
      return box;
    }));
    main.append(section("soft", heading("Why we need you", org.headline || `Every ${settings.one} deserves a good start.`), stats));
  }

  const two = el("div", "sp-two");
  const left = el("div");
  left.append(heading("What sponsors receive", "More than a thank-you."), ticks(receiveList(settings)));
  const right = el("div");
  right.append(heading("How your gift helps", "Every month, it pays for:"), helpsGrid(settings.helps.slice(0, 4)));
  right.append(el("p", "sp-pool", `Every gift goes into one fund for ${midSentence(org.everyone)}. Your ${settings.one} is who you'll hear about.`));
  two.append(left, right);
  main.append(section("", two));

  const steps = el("div", "sp-steps");
  const stepText = [
    [`Pick a ${settings.one}`, `Browse our ${settings.follow.toLowerCase()} and choose one to follow.`],
    ["Choose your gift", `Any amount, monthly or one time, straight to ${org.name}. Cancel anytime.`],
    ["Get the updates", "Photos and news through the year."],
  ];
  steps.append(...stepText.map(([h, p], i) => {
    const box = el("div", "sp-step");
    box.append(el("div", "n", String(i + 1)), el("h3", "", h), el("p", "", p));
    return box;
  }));
  const how = section("soft", heading("How it works", "Three steps, about a minute."), steps);
  how.id = "how";
  main.append(how);

  if (settings.stories.length) {
    const stories = el("div", "sp-stories");
    stories.append(...settings.stories.map((s) => {
      const card = el("div", "sp-story");
      const photo = safeImageUrl(s.photo);
      if (photo) {
        const img = el("img");
        img.src = photo;
        img.alt = "";
        card.append(img);
      }
      const body = el("div");
      body.append(el("b", "", s.title), el("p", "", s.text));
      card.append(body);
      return card;
    }));
    main.append(section("", heading("Happy endings", "Who our sponsors have helped."), stories));
  }

  const faq = el("div", "sp-faq");
  faq.append(...faqList(settings, org.name, org.feeOn).map((item, i) => {
    const d = el("details");
    if (i === 0) d.open = true;
    d.append(el("summary", "", item.q), el("p", "", item.a));
    return d;
  }));
  const closing = el("div", "sp-center");
  closing.style.marginTop = "30px";
  closing.append(link("btn btn-primary btn-lg", `Choose a ${settings.one} to sponsor`, viewLink(org.slug, "browse")));
  const questions = section("", heading("Questions", "Good to know"), faq, closing);
  questions.id = "questions";
  main.append(questions);
  // Grey and white take turns, whichever optional sections (numbers, happy endings) this page has.
  [...main.querySelectorAll(".sp-section")].forEach((s, i) => s.classList.toggle("soft", i % 2 === 0));
  $("main").replaceChildren(main);
}

// ---------- browse list ----------

function card(item) {
  const box = el("article", "sp-card");
  const ph = link("ph", null, viewLink(org.slug, "profile", item));
  ph.append(photoOf(item));
  if (item.isGroup) ph.append(el("span", "grp", "Group"));
  const body = el("div", "body");
  body.append(el("h3", "", item.name));
  const chips = factChips(item, settings.factFields);
  const tags = chips.length ? chips.map((c) => c.value) : item.badge ? [item.badge] : [];
  if (tags.length) {
    const row = el("div", "sp-chips");
    row.append(...tags.map((t) => el("span", "sp-chip", t)));
    body.append(row);
  }
  body.append(link("btn btn-dark btn-block", `Meet ${item.name}`, viewLink(org.slug, "profile", item)));
  box.append(ph, body);
  return box;
}

function drawBrowse() {
  const options = filterOptions(org.items, settings.factFields);
  let filterKey = "all";
  let sortKey = "waiting";
  const head = el("div", "container sp-browse-head");
  head.append(heading(`Our ${settings.follow.toLowerCase()}`, `Choose a ${settings.one} to sponsor`, `Whoever you pick, your gift helps ${midSentence(org.everyone)}.`));
  const tools = el("div", "sp-tools");
  const count = el("p", "sp-count");
  const grid = el("div", "sp-grid");
  const sort = el("label", "sp-sort", "Sort:");
  const select = el("select");
  for (const [key, value] of Object.entries(SORTS)) {
    const option = el("option", "", value.label);
    option.value = key;
    select.append(option);
  }
  sort.append(select);
  const draw = () => {
    const list = browseList(org.items, filterKey, sortKey, options);
    count.textContent = `${list.length} to choose from`;
    grid.replaceChildren(...list.map(card));
    [...tools.querySelectorAll(".sp-filter")].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === filterKey)));
  };
  if (options.length > 1) {
    tools.append(...options.map((option) => {
      const b = el("button", "sp-filter", option.label);
      b.type = "button";
      b.dataset.key = option.key;
      b.addEventListener("click", () => {
        filterKey = option.key;
        draw();
      });
      return b;
    }));
  }
  tools.append(sort);
  select.addEventListener("change", () => {
    sortKey = select.value;
    draw();
  });
  head.append(tools, count);
  const wrap = el("div", "container");
  wrap.append(grid);
  $("main").replaceChildren(head, wrap);
  draw();
}

// ---------- one profile ----------

function gallery(item) {
  const box = el("div", "sp-gallery");
  const photos = [{ src: item.photo || "photos/dog-smile.jpg", focus: item.focus }, ...(item.morePhotos ?? []).map((src) => ({ src, focus: "" }))];
  const main = el("img", "main");
  const show = (p) => {
    main.src = p.src;
    main.style.objectPosition = p.focus ?? "";
  };
  show(photos[0]);
  main.alt = item.name;
  box.append(main);
  if (photos.length > 1) {
    const thumbs = el("div", "sp-thumbs");
    thumbs.append(...photos.map((p, i) => {
      const b = el("button");
      b.type = "button";
      b.setAttribute("aria-label", `Photo ${i + 1} of ${item.name}`);
      b.setAttribute("aria-pressed", String(i === 0));
      const img = el("img");
      img.src = p.src;
      img.alt = "";
      if (p.focus) img.style.objectPosition = p.focus;
      b.append(img);
      b.addEventListener("click", () => {
        show(p);
        [...thumbs.children].forEach((other) => other.setAttribute("aria-pressed", String(other === b)));
      });
      return b;
    }));
    box.append(thumbs);
  }
  return box;
}

function buyBox(item) {
  const box = el("div", "sp-buy");
  const p = el("p", "p");
  p.append(el("b", "", "Any amount"), ", monthly or one time");
  box.append(p, sponsorButton(item, "btn btn-primary btn-lg btn-block"));
  box.append(el("small", "", `Cancel anytime. Every gift helps everyone at ${org.name}.`));
  return box;
}

function shareBox(item) {
  const box = el("div", "sp-share");
  box.append(el("b", "", `Know someone who'd love ${item.name}?`));
  const url = shareLink(org.slug, item.name);
  const copy = el("button", "", "Copy link");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = url;
    }
  });
  box.append(copy);
  if (typeof navigator.share === "function") {
    const share = el("button", "", "Share");
    share.type = "button";
    share.addEventListener("click", () => navigator.share({ title: `Sponsor ${item.name}`, url }).catch(() => {}));
    box.append(share);
  }
  return box;
}

function block(title, ...children) {
  const box = el("div", "sp-block");
  box.append(el("h2", "", title), ...children);
  return box;
}

function drawProfile(item) {
  document.title = `${item.name} | ${org.name}`;
  const wrap = el("div", "container");
  wrap.append(link("sp-back", `← All ${settings.follow.toLowerCase()}`, viewLink(org.slug, "browse")));
  const top = el("div", "sp-profile");
  const intro = el("div", "sp-intro");
  const head = profileHeading(item, settings);
  intro.append(el("h1", "", head.title));
  if (head.tagline) intro.append(el("p", "sp-tagline", head.tagline));
  const chips = factChips(item, settings.factFields);
  const chipTexts = chips.map((c) => `${c.field}: ${c.value}`);
  if (item.badge) chipTexts.push(item.badge);
  if (chipTexts.length) {
    const row = el("div", "sp-chips");
    row.append(...chipTexts.map((t) => el("span", "sp-chip", t)));
    intro.append(row);
  }
  intro.append(buyBox(item), shareBox(item));
  top.append(gallery(item), intro);
  wrap.append(top);

  const labels = profileLabels(item, settings);
  const about = storyParagraphs(item.story);
  if (!about.length && item.note && head.tagline !== item.note) about.push(item.note);
  if (about.length) wrap.append(block(labels.about, ...about.map((t) => el("p", "", t))));
  if (item.why) wrap.append(block(labels.why, el("p", "", item.why)));
  const helps = block("Your gift helps with", helpsGrid(settings.helps.slice(0, 4), true));
  helps.classList.add("wide");
  wrap.append(helps);
  if (item.loves || item.dislikes) {
    const loves = el("div", "sp-loves");
    if (item.loves) {
      const box = el("div", "sp-love");
      box.append(el("b", "", labels.loves), item.loves);
      loves.append(box);
    }
    if (item.dislikes) {
      const box = el("div", "sp-love");
      box.append(el("b", "", labels.dislikes), item.dislikes);
      loves.append(box);
    }
    wrap.append(block(settings.firstPerson ? "A few things about me" : "Good to know", loves));
  }
  wrap.append(block(`Sponsor ${item.name} and you'll get`, ticks(receiveList(settings, item.name))));
  const again = el("div", "sp-center");
  again.style.margin = "40px 0 10px";
  again.append(sponsorButton(item, "btn btn-primary btn-lg"));
  wrap.append(again);

  const others = org.items.filter((other) => other !== item).slice(0, 4);
  if (others.length) {
    const row = el("div", "sp-more");
    row.append(...others.map((other) => {
      const mini = link("sp-mini", null, viewLink(org.slug, "profile", other));
      mini.append(photoOf(other), el("b", "", other.name));
      const chip = factChips(other, settings.factFields)[0]?.value ?? other.badge;
      if (chip) mini.append(el("span", "", chip));
      return mini;
    }));
    const more = block(`More ${settings.follow.toLowerCase()} to meet`, row);
    more.classList.add("wide");
    more.style.marginBottom = "40px";
    wrap.append(more);
  }
  $("main").replaceChildren(wrap);
}

// ---------- start ----------

async function start() {
  try {
    org = await loadLiveOrg(String(params.get("org") ?? "").toLowerCase());
  } catch {
    org = null;
  }
  if (!org) {
    $("main").replaceChildren(el("p", "sp-problem", "We couldn't find that page. Check the link, or open it from the nonprofit's dashboard while signed in."));
    return;
  }
  settings = pageSettings(org);
  setUpCheckout();
  const view = readView(location.search, org.items);
  drawChrome(view.page);
  if (view.page === "profile") drawProfile(view.item);
  else if (view.page === "browse") drawBrowse();
  else drawHome();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  if (params.has("session_id")) showReturnThanks(org); // back from a bank app or similar
}

start();
