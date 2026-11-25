// sponsor-page.js - the new sponsor pages (sponsor.html), phase 1 of the Dogs Trust-style rebuild:
//   sponsor.html?org=lucky-pup-rescue            the home page
//   sponsor.html?org=lucky-pup-rescue&view=all   the browse list (filters and sorting)
//   sponsor.html?org=lucky-pup-rescue&dog=burt   one profile (a dog, a group or a program)
// Everything a nonprofit typed is shown as plain text (textContent), never as HTML.
// Until the new checkout (phase 3), the Sponsor buttons open the current checkout on give.html.

import { applyBrand, applyTheme, safeImageUrl } from "./brand.js?v=20261125b";
import { openCheckout, setUpCheckout, showReturnThanks } from "./checkout.js";
import { loadLiveOrg } from "./live.js?v=20261125b";
import { shareLink } from "./share.js";
import { browseList, factChips, filterOptions, heroWords, profileHeading, profileLabels, readView, shortIntro, SORTS, viewLink } from "./sponsor-page-logic.js?v=20261125b";
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

/** A label and a headline; accent is the one green italic phrase at the end (optional, 2 to 4 words). */
function heading(eyebrow, title, lead, accent = "") {
  const box = el("div");
  const h2 = el("h2", "sp-h2", accent ? `${title} ` : title);
  if (accent) h2.append(el("span", "accent", accent));
  box.append(el("div", "sp-eyebrow", eyebrow), h2);
  if (lead) box.append(el("p", "sp-lead", lead));
  return box;
}

/** Cover's own "covered" drawings stand in for each "gift helps with" choice (no generic icons). */
const DRAWING_FOR = { bowl: "bowl", home: "house", learn: "book", cart: "apple", leaf: "apple" };
function drawingFor(icon) {
  return `brand/drawings/covered-${DRAWING_FOR[icon] ?? "heart"}.png`;
}

function helpsGrid(helps, four = false) {
  const grid = el("div", `sp-helps${four ? " four" : ""}`);
  for (const help of helps) {
    const card = el("div", "sp-help");
    const icon = tinted("ic", drawingFor(help.icon)); // drawn in the nonprofit's color
    card.append(icon, el("b", "", help.title));
    if (help.text) card.append(el("span", "", help.text));
    grid.append(card);
  }
  return grid;
}

/** One of Cover's drawings, painted in the page's color (so it matches a nonprofit's own color). */
function tinted(className, src) {
  const span = el("span", `${className} tint`);
  // A full address: inside the stylesheet, a short one would be read from the css/ folder.
  span.style.setProperty("--src", `url("${new URL(src, document.baseURI).href}")`);
  span.setAttribute("aria-hidden", "true");
  return span;
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
  applyTheme(document.body, org.brandColor); // their color across the new look (buttons, dark sections, drawings)
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
  // The photo sits beside the words (never under them), so text never covers a face.
  const hero = el("header", "sp-hero");
  const heroImg = el("img");
  heroImg.src = safeImageUrl(org.heroPhotoWide) || org.items[0]?.photo || "photos/dog-smile.jpg";
  heroImg.alt = "";
  const words = el("div", "dark sp-hero-words");
  // Their own headline and intro when they wrote them; otherwise "Sponsor a dog."
  const own = heroWords(org.ownHeadline);
  const h1 = el("h1", own ? "own" : "", own ? `${own.main} ` : "Sponsor ");
  h1.append(el("span", "accent", own ? own.accent : `a ${settings.one}.`));
  words.append(el("div", "sp-eyebrow", org.name), h1);
  const intro = [own?.rest, shortIntro(org.ownLead)].filter(Boolean).join(" ");
  if (intro) words.append(el("p", "sp-intro", intro));
  const price = el("p", "sp-price");
  price.append(el("b", "", "Any amount"), ", monthly or one time.");
  const cta = link("btn btn-cream btn-lg", `Choose a ${settings.one} to sponsor`, viewLink(org.slug, "browse"));
  cta.append(tinted("arrow", "brand/drawings/arrow-moss.png"));
  words.append(price, cta);
  hero.append(heroImg, words);
  main.append(hero);

  // Their dogs, right on the home page (the ones waiting longest first).
  if (org.items.length) {
    const meet = el("div", "sp-grid sp-meet");
    meet.append(...browseList(org.items, "all", "waiting", []).slice(0, 6).map(card));
    const all = link("textlink", `See all ${org.items.length} ${settings.follow.toLowerCase()}`, viewLink(org.slug, "browse"));
    main.append(section("", heading(`Our ${settings.follow.toLowerCase()}`, "Meet the ones", "", "waiting for you."), meet, all));
  }

  if (settings.stats.length) {
    const stats = el("div", "sp-stats");
    stats.append(...settings.stats.map((s) => {
      const box = el("div", "sp-stat");
      box.append(el("b", "", s.value), el("span", "", s.label));
      return box;
    }));
    main.append(section("dark", heading("Why we need you", org.headline || `Every ${settings.one} deserves a good start.`), stats));
  }

  const two = el("div", "sp-two");
  const left = el("div");
  left.append(heading("What sponsors receive", "More than", "", "a thank-you."), ticks(receiveList(settings)));
  const right = el("div");
  right.append(heading("How your gift helps", "Every month,", "", "it pays for:"), helpsGrid(settings.helps.slice(0, 4)));
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
    box.append(el("div", "n", String(i + 1).padStart(2, "0")), el("h3", "", `${h}.`), el("p", "", p));
    return box;
  }));
  const how = section("dark", heading("How it works", "Three steps, about a minute."), steps);
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
    main.append(section("", heading("Happy endings", "Who our sponsors", "", "have helped."), stories));
  }

  const wall = thankYouWall();
  if (wall) main.append(wall);

  const faq = el("div", "sp-faq");
  faq.append(...faqList(settings, org.name, org.feeOn).map((item, i) => {
    const d = el("details");
    if (i === 0) d.open = true;
    d.append(el("summary", "", item.q), el("p", "", item.a));
    return d;
  }));
  const closing = el("div");
  closing.style.marginTop = "48px";
  closing.append(link("btn btn-primary btn-lg", `Choose a ${settings.one} to sponsor`, viewLink(org.slug, "browse")));
  const questions = section("", heading("Questions", "Good to know."), faq, closing);
  questions.id = "questions";
  main.append(questions);
  $("main").replaceChildren(main);
}

const WALL_FIRST_SHOW = 24; // names on the card before "See everyone"

/** The thank-you wall: only sponsors who said yes, names only. */
function thankYouWall() {
  const names = org.wall ?? [];
  if (!names.length) return null;
  const wall = el("section", "thanks-wall sp-wall");
  const c = el("div", "container");
  const card = el("div", "note-card");
  const title = el("h2", "sp-h2", "Thank you, ");
  title.append(el("span", "accent", "neighbors."));
  const list = el("ul", "sigs");
  const more = el("button", "link-btn wall-more", "See everyone →");
  more.type = "button";
  const draw = (all) => {
    list.replaceChildren(...(all ? names : names.slice(0, WALL_FIRST_SHOW)).map((name) => el("li", "", name)));
    more.hidden = all || names.length <= WALL_FIRST_SHOW;
  };
  more.addEventListener("click", () => draw(true));
  draw(false);
  card.append(list, el("p", "note-from", `Love, everyone at ${org.name}`));
  c.append(el("div", "sp-eyebrow", "Our sponsors"), title, card, more);
  wall.append(c);
  return wall;
}

// ---------- browse list ----------

/** A full-photo card: the photo fills it, the name and facts sit on a deep moss fade at the bottom. */
function card(item) {
  const box = link("sp-card", null, viewLink(org.slug, "profile", item));
  box.append(photoOf(item), el("div", "fade"));
  if (item.isGroup) box.append(el("span", "grp", "Group"));
  const body = el("div", "body");
  body.append(el("h3", "", item.name));
  const chips = factChips(item, settings.factFields);
  const tags = chips.length ? chips.map((c) => c.value) : item.badge ? [item.badge] : [];
  if (tags.length) body.append(el("p", "facts", tags.join(", ")));
  body.append(el("span", "btn btn-cream btn-block", `Meet ${item.name}`));
  box.append(body);
  return box;
}

function drawBrowse() {
  const options = filterOptions(org.items, settings.factFields);
  let filterKey = "all";
  let sortKey = "waiting";
  const head = el("div", "container sp-browse-head");
  head.append(heading(`Our ${settings.follow.toLowerCase()}`, `Choose a ${settings.one}`, `Whoever you pick, your gift helps ${midSentence(org.everyone)}.`, "to sponsor."));
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
  again.style.margin = "48px 0 16px";
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
