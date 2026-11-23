// dashboard.js - the signed-in nonprofit's dashboard: overview, sponsors, things to follow,
// page settings, and Stripe's embedded screens (sign-up, payments, payouts, account).
//
// Everything read or changed here goes through the database's safety rules as this person,
// so they only ever see and edit their own nonprofit. Typed text is shown with textContent only.

import { STRIPE_PUBLISHABLE_KEY } from "./config.js";
import {
  DEFAULT_FOCUS, MORE_PHOTOS_MAX, PHOTO_MAX_BYTES, checklist, clampFocus, countsByItem, fitWithin, focusFromClick, followedMost,
  finishSummary, greeting, monthStats, nameFromFile, newestSponsors, objectPosition, photoPath, photoProblem, postSummary, slugify,
  sponsorName, statusLabel, updateAudience, validateItem, validatePage, validateSignup, wallName, wallStatus, welcomeCandidates,
  welcomeCaption, welcomeFileName, welcomeHeadline, whenText,
} from "./dashboard-logic.js";
import { finishSignInFromLink } from "./auth-link.js";
import { recordTermsAgreement } from "./terms.js";
import { canvasToPng, drawWelcome } from "./welcome-image.js";
import { applyBrand, BRAND_SWATCHES, normalizeHex, safeImageUrl, validateLook } from "./brand.js";
import { money } from "./sponsor.js";
import { drawQr, qrFileName, shareLink, signLink } from "./share.js";
import { callServer, pageUrl, supabase } from "./supabase.js";

const LOGO_LONG_SIDE = 512; // logos are small on screen; this keeps them sharp on phones
const CHECK_SVG = '<svg viewBox="0 0 24 24"><polyline points="5,12.5 10,17 19,7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const AVATAR_COLORS = ["#C98B5E", "#5B8F7E", "#7B7FB8", "#B86E7B", "#6E9BB8", "#A08A4E"];
const $ = (id) => document.getElementById(id);

const state = { user: null, nonprofit: null, items: [], sponsors: [], connect: null, mounted: new Set(), editing: null, finishing: null, accountCreated: false, role: null, admin: false, memberships: [], creatingFor: null, focus: { x: 50, y: 38 }, look: { logo: "", coverPhoto: "" }, morePhotos: [] };

/** True once the nonprofit has a Stripe account (saved earlier, or just created by Stripe's sign-up form). */
const hasStripeAccount = () => Boolean(state.nonprofit?.stripe_account_id) || state.accountCreated;

// ---------- small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function checkIcon() {
  const span = el("span", "check");
  span.innerHTML = CHECK_SVG;
  return span;
}

let toastTimer;
function toast(message) {
  $("toast-msg").textContent = message;
  $("toast-msg").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast-msg").hidden = true), 3200);
}

function showErrors(prefix, errors) {
  document.querySelectorAll(`[id^="${prefix}"]`).forEach((node) => (node.textContent = ""));
  for (const [field, message] of Object.entries(errors)) {
    const target = $(`${prefix}${field}`);
    if (target) target.textContent = message;
  }
}

const label = () => state.nonprofit.page?.navLabel || "Things to follow";
const singular = () => label().replace(/s$/i, "") || "one";
const publicUrl = () => `${pageUrl("give.html")}?org=${state.nonprofit.slug}`;
const linkSharedKey = () => `cover.linkShared.${state.nonprofit.id}`;
function linkShared() {
  try {
    return localStorage.getItem(linkSharedKey()) === "yes";
  } catch {
    return false;
  }
}

// ---------- loading ----------

async function loadNonprofit(nonprofitId) {
  const [np, items, sponsors] = await Promise.all([
    supabase.from("nonprofits").select("*").eq("id", nonprofitId).single(),
    supabase.from("follow_items").select("*").eq("nonprofit_id", nonprofitId).order("sort_order").order("created_at"),
    supabase.from("sponsors")
      .select("id, item_id, first_name, last_initial, email, business_name, monthly_cents, status, updates_off, show_name, wall_hidden, created_at")
      .eq("nonprofit_id", nonprofitId)
      .order("created_at", { ascending: false }),
  ]);
  for (const result of [np, items, sponsors]) if (result.error) throw result.error;
  state.nonprofit = np.data;
  state.items = items.data;
  state.sponsors = sponsors.data;
}

async function refreshStripeStatus() {
  if (!hasStripeAccount()) return null;
  try {
    const result = await callServer("stripe-connect", { action: "status", nonprofitId: state.nonprofit.id });
    state.nonprofit.is_live = result.live;
    return result;
  } catch (error) {
    console.warn("Couldn't check Stripe status", error);
    return null;
  }
}

// ---------- Stripe's embedded screens ----------

function waitForConnectJs() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function check() {
      if (window.StripeConnect?.init) return resolve(window.StripeConnect);
      if (Date.now() - started > 15000) return reject(new Error("The payment screens didn't load. Refresh the page."));
      setTimeout(check, 100);
    })();
  });
}

async function stripeConnect() {
  if (state.connect) return state.connect;
  const StripeConnect = await waitForConnectJs();
  state.connect = StripeConnect.init({
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    fetchClientSecret: async () => {
      const { clientSecret } = await callServer("stripe-connect", { action: "session", nonprofitId: state.nonprofit.id });
      state.accountCreated = true; // the first session creates the Stripe account
      return clientSecret;
    },
    // Stripe's screens load the same font so they match the rest of the dashboard.
    fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" }],
    appearance: { variables: { colorPrimary: "#0B6B47", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", borderRadius: "10px" } },
  });
  return state.connect;
}

async function mountStripe(component, mountId, configure) {
  if (state.mounted.has(mountId)) return;
  state.mounted.add(mountId);
  try {
    const instance = await stripeConnect();
    const element = instance.create(component);
    configure?.(element);
    $(mountId).replaceChildren(element);
  } catch (error) {
    state.mounted.delete(mountId);
    $(mountId).replaceChildren(el("p", "empty", error.message));
  }
}

// ---------- overview ----------

function drawOverview() {
  const np = state.nonprofit;
  const stats = monthStats(state.sponsors, np.monthly_goal_cents);
  $("hello").textContent = `${greeting()}, ${np.name}`;
  $("page-link-text").textContent = publicUrl().replace(/^https?:\/\//, "");
  $("view-page").href = publicUrl();
  $("view-page-2").href = publicUrl();
  $("m-covered").textContent = money(stats.covered);
  $("m-goal").textContent = `of ${money(stats.goal)} goal`;
  $("m-bar").style.width = `${stats.percent}%`;
  $("m-pct").textContent = `${stats.percent}% covered`;
  $("m-togo").textContent = stats.sponsorsToGoal ? `${stats.sponsorsToGoal} more sponsors reaches your goal` : "Goal reached!";
  $("t-active").textContent = stats.activeCount;
  $("t-active-new").textContent = stats.newThisMonth ? `+${stats.newThisMonth} this month` : "";
  $("t-biz").textContent = stats.businesses;
  $("t-biz-new").textContent = stats.businessesNew ? `+${stats.businessesNew} this month` : "";
  $("t-new").textContent = stats.newThisMonth;

  const rows = newestSponsors(state.sponsors, state.items, 5);
  const table = $("newest");
  if (!rows.length) {
    table.replaceChildren(el("tr", "", null));
    table.firstChild.append(el("td", "empty", "No sponsors yet. Share your page link to get your first one."));
  } else {
    const head = el("tr");
    ["Sponsor", "Following", "Monthly", "Status"].forEach((h) => head.append(el("th", "", h)));
    table.replaceChildren(head, ...rows.map((row, i) => sponsorRow(row, i, false)));
  }
  $("attention").replaceChildren();
  if (stats.needsAttention) {
    const box = el("div", "alert");
    box.append(el("b", "", `${stats.needsAttention} sponsor${stats.needsAttention > 1 ? "s'" : "'s"} card failed. `),
      el("span", "", "We retry the card automatically and email them to update it. Nothing you need to do."));
    $("attention").append(box);
  }

  const todo = checklist({ nonprofit: np, items: state.items, linkShared: linkShared() });
  $("todo-count").textContent = `${todo.done} of ${todo.steps.length} done`;
  $("todo").replaceChildren(...todo.steps.map((step) => {
    const li = el("li");
    li.append(step.done ? checkIcon() : el("span", "ring"), el("span", step.done ? "done-text" : "", step.text));
    if (!step.done && step.action) {
      const go = el("a", "go", step.action === "connect" ? "Set up" : step.action === "share" ? "Copy link" : "Add");
      go.href = "#";
      go.addEventListener("click", (event) => {
        event.preventDefault();
        if (step.action === "share") copyLink();
        else show(step.action);
      });
      li.append(go);
    }
    return li;
  }));

  const most = followedMost(state.items, state.sponsors);
  $("most").replaceChildren(...(most.length ? most.slice(0, 5).map((item, i) => {
    const tr = el("tr");
    const right = el("td", "", `${item.sponsors} sponsor${item.sponsors === 1 ? "" : "s"}`);
    right.style.textAlign = "right";
    if (i === most.length - 1 && most.length > 1 && item.sponsors <= 1) {
      right.textContent += " · needs some love";
      right.style.color = "var(--green-dark)";
      right.style.fontWeight = "650";
    }
    tr.append(el("td", "", item.name), right);
    return tr;
  }) : [(() => { const tr = el("tr"); tr.append(el("td", "empty", `Add ${label().toLowerCase()} so people can pick one.`)); return tr; })()]));
}

function sponsorRow(row, index, full) {
  const tr = el("tr");
  const who = el("div", "who");
  const avatar = el("span", "avatar", (sponsorName(row)[0] ?? "?").toUpperCase());
  avatar.style.background = AVATAR_COLORS[index % AVATAR_COLORS.length];
  const name = el("div", "", sponsorName(row));
  name.append(el("small", "", `${whenText(row.created_at)}${row.business_name ? " · business" : ""}`));
  who.append(avatar, name);
  const whoCell = el("td");
  whoCell.append(who);
  const statusCell = el("td");
  const badge = row.label ?? statusLabel(row.status);
  statusCell.append(el("span", `status s-${badge.tone}`, badge.text));
  tr.append(whoCell);
  if (full) tr.append(el("td", "", row.email));
  tr.append(el("td", "", row.following), el("td", "", money(row.monthly_cents / 100)), statusCell);
  if (full) tr.append(wallCell(row));
  return tr;
}

/** "On the wall / Hidden by you / Private" plus the owner's Hide or Show button. */
function wallCell(row) {
  const cell = el("td", "wall-cell");
  const wall = wallStatus(row);
  const pill = el("span", `status s-${wall.tone}`, wall.text);
  if (wall.tone !== "off") pill.title = `Shows as "${wallName(row)}"`;
  cell.append(pill);
  if (wall.button) {
    const button = el("button", "mini-btn", wall.button);
    button.type = "button";
    button.setAttribute("aria-label", `${wall.button} ${wallName(row)} on the thank-you wall`);
    button.addEventListener("click", () => setWallHidden(row, wall.hide, button));
    cell.append(button);
  }
  return cell;
}

async function setWallHidden(row, hide, button) {
  button.disabled = true;
  const { error } = await supabase.rpc("set_wall_hidden", { target_sponsor: row.id, hidden: hide });
  if (error) {
    button.disabled = false;
    toast("That didn't save. Please try again.");
    return;
  }
  const sponsor = state.sponsors.find((s) => s.id === row.id);
  if (sponsor) sponsor.wall_hidden = hide;
  drawSponsors();
  toast(hide ? `${wallName(row)} is hidden from your thank-you wall` : `${wallName(row)} is back on your thank-you wall`);
}

// ---------- share a welcome ----------

let welcomeFile = "welcome.png";

/** New opted-in sponsors, each with a "Make welcome post" button. Hidden when there's no one. */
function drawWelcomeList() {
  const picks = welcomeCandidates(state.sponsors, state.items);
  $("welcome-panel").hidden = picks.length === 0;
  $("welcome-list").replaceChildren(...picks.map((pick) => {
    const row = el("div", "welcome-row");
    const who = el("div", "who", wallName(pick.sponsor));
    who.append(el("small", "", `Follows ${pick.item.name} · joined ${whenText(pick.sponsor.created_at)}`));
    const button = el("button", "btn btn-ghost", "Make welcome post");
    button.type = "button";
    button.addEventListener("click", () => openWelcome(pick));
    row.append(who, button);
    return row;
  }));
}

async function openWelcome(pick) {
  const np = state.nonprofit;
  const headline = welcomeHeadline(pick.greet, pick.item.name);
  welcomeFile = welcomeFileName(pick.greet, pick.item.name);
  $("welcome-sub").textContent = `${wallName(pick.sponsor)} just started sponsoring ${pick.item.name}.`;
  $("welcome-caption").value = welcomeCaption({ greet: pick.greet, itemName: pick.item.name, nonprofitName: np.name, kind: np.kind, link: publicUrl() });
  $("welcome-error").textContent = "";
  $("welcome-download").disabled = true;
  $("welcome-dialog").showModal();
  try {
    const hasPhoto = await drawWelcome($("welcome-canvas"), {
      photoUrl: safeImageUrl(pick.item.photo_url),
      focus: clampFocus(pick.item.photo_focus_x, pick.item.photo_focus_y),
      brandColor: np.page?.brandColor ?? null,
      nonprofitName: np.name,
      headline,
    });
    $("welcome-photo-note").hidden = hasPhoto;
    $("welcome-download").disabled = false;
  } catch (error) {
    console.error(error);
    $("welcome-error").textContent = "We couldn't make the picture. Try again in a moment.";
  }
}

async function downloadWelcome() {
  try {
    const blob = await canvasToPng($("welcome-canvas"));
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = welcomeFile;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch {
    $("welcome-error").textContent = "We couldn't save the picture. Try again, or take a screenshot of it.";
  }
}

async function copyWelcomeCaption() {
  const box = $("welcome-caption");
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select(); // older browsers: select it so they can copy by hand
    document.execCommand?.("copy");
  }
  toast("Caption copied");
}

function drawSponsors() {
  drawWelcomeList();
  const names = new Map(state.items.map((item) => [item.id, item.name]));
  const rows = state.sponsors.map((s) => ({ ...s, following: names.get(s.item_id) ?? "—" }));
  const table = $("all-sponsors");
  if (!rows.length) {
    const tr = el("tr");
    tr.append(el("td", "empty", "No sponsors yet."));
    table.replaceChildren(tr);
    return;
  }
  const head = el("tr");
  ["Sponsor", "Email", "Following", "Monthly", "Status", "Thank-you wall"].forEach((h) => head.append(el("th", "", h)));
  table.replaceChildren(head, ...rows.map((row, i) => sponsorRow(row, i, true)));
}

// ---------- things to follow ----------

function drawItems() {
  $("items-title").textContent = label();
  $("nav-items-label").textContent = label();
  $("add-item").textContent = `+ Add ${singular().toLowerCase()}`;
  const counts = countsByItem(state.sponsors);
  const cards = state.items.map((item) => {
    const card = el("div", `item-card${item.status === "finished" ? " finished" : ""}`);
    if (item.photo_url) {
      const img = el("img");
      img.src = item.photo_url;
      img.alt = item.name;
      img.style.objectPosition = objectPosition(item);
      card.append(img);
    } else {
      card.append(el("div", "no-photo", "No photo yet"));
    }
    const body = el("div", "b");
    const row = el("div", "row");
    const count = counts.get(item.id) ?? 0;
    row.append(el("h3", "", item.name), el("span", `status ${item.status === "finished" ? "s-new" : "s-active"}`,
      item.status === "finished" ? "Finished" : `${count} sponsor${count === 1 ? "" : "s"}`));
    body.append(row, el("p", "", item.status === "finished" ? item.finished_note || "Finished" : [item.badge, item.note].filter(Boolean).join(" · ")));
    const actions = el("div", "actions");
    const edit = el("button", "btn btn-ghost", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openItem(item));
    actions.append(edit);
    if (item.status === "active") {
      const share = el("button", "btn btn-ghost", "Share");
      share.type = "button";
      share.addEventListener("click", () => openShare(item));
      actions.append(share);
      const update = el("button", "btn btn-primary", "Post update");
      update.type = "button";
      update.addEventListener("click", () => openPostUpdate(item));
      actions.append(update);
      const finish = el("button", "btn btn-dark", state.nonprofit.kind === "animal" ? "Mark adopted" : "Mark finished");
      finish.type = "button";
      finish.addEventListener("click", () => openFinish(item));
      actions.append(finish);
    } else {
      const reopen = el("button", "btn btn-ghost", "Bring back");
      reopen.type = "button";
      reopen.addEventListener("click", () => setItemStatus(item, "active", null));
      actions.append(reopen);
    }
    body.append(actions);
    card.append(body);
    return card;
  });
  const add = el("button", "add-card");
  add.type = "button";
  const inner = el("div");
  inner.append(el("div", "plus", "+"), el("div", "", `Add ${singular().toLowerCase()}`), el("span", "", "Photo, name and one line about them"));
  inner.lastChild.style.cssText = "font-weight:400;font-size:13px";
  add.append(inner);
  add.addEventListener("click", () => openItem(null));
  $("item-grid").replaceChildren(...cards, add);
}

function openItem(item) {
  state.editing = item;
  state.focus = clampFocus(item?.photo_focus_x, item?.photo_focus_y);
  const form = $("item-form");
  form.reset();
  showErrors("ie-", {});
  $("item-dialog-title").textContent = item ? `Edit ${item.name}` : `Add ${singular().toLowerCase()}`;
  $("item-dialog-sub").textContent = state.nonprofit.name;
  form.elements.name.value = item?.name ?? "";
  form.elements.badge.value = item?.badge ?? "";
  form.elements.note.value = item?.note ?? "";
  form.elements.story.value = item?.story ?? "";
  $("i-story-count").textContent = form.elements.story.value.length;
  state.morePhotos = [...(item?.more_photos ?? [])];
  drawMorePhotos();
  showCropEditor(item?.photo_url ?? "");
  $("item-save").disabled = false;
  $("item-dialog").showModal();
  form.elements.name.focus();
}

// ---------- Share: link, QR code and printable sign (Nov 23) ----------

/** Open the Share box for the whole page (item = null) or one dog. */
async function openShare(item = null) {
  const np = state.nonprofit;
  const link = shareLink(np.slug, item?.name ?? null);
  $("share-title").textContent = item ? `Share ${item.name}` : "Share your page";
  $("share-sub").textContent = np.name;
  $("share-url").textContent = link.replace(/^https:\/\//, "");
  $("share-copy").textContent = "Copy link";
  $("share-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $("share-copy").textContent = "Copied";
    } catch {
      $("share-copy").textContent = "Copy it above";
    }
  };
  // On phones: the phone's own share menu (Messages, Facebook, email...).
  $("share-native").hidden = typeof navigator.share !== "function";
  $("share-native").onclick = () => navigator.share({ title: item ? `Sponsor ${item.name}` : np.name, url: link }).catch(() => {});
  $("share-sign").href = signLink(np.slug, item?.name ?? null);
  $("share-dialog").showModal();
  const hasQr = await drawQr($("share-qr"), link);
  $("share-qr-wrap").hidden = !hasQr;
  $("share-download").onclick = () => {
    $("share-qr").toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = qrFileName(np.slug, item?.name ?? null);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };
}

$("share-page").addEventListener("click", () => openShare(null));
$("share-close").addEventListener("click", () => $("share-dialog").close());

// ---------- photos: shrink, turn upright, and choose the crop ----------

/** Shrink a phone photo to at most 1600px on its longest side, turned upright, as a JPG. */
async function shrinkPhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name || "That photo"} couldn't be opened. If it's an iPhone HEIC photo, share it as a JPG (or screenshot it) and try again.`);
  }
  const size = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  for (const quality of [0.86, 0.72, 0.6]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= PHOTO_MAX_BYTES) return new File([blob], "photo.jpg", { type: "image/jpeg" });
  }
  throw new Error("That photo is too big even after shrinking. Try another one.");
}

/** Shrink a logo to at most 512px as a PNG, so a see-through background stays see-through. */
async function shrinkLogo(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That logo couldn't be opened. Try a PNG or JPG.");
  }
  const size = fitWithin(bitmap.width, bitmap.height, LOGO_LONG_SIDE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob || blob.size > PHOTO_MAX_BYTES) throw new Error("That logo is too big. Try a smaller file.");
  return new File([blob], "logo.png", { type: "image/png" });
}

async function uploadPhoto(file, { logo = false } = {}) {
  const small = logo ? await shrinkLogo(file) : await shrinkPhoto(file);
  const path = photoPath(state.nonprofit.id, small, crypto.randomUUID());
  const { error } = await supabase.storage.from("photos").upload(path, small, { contentType: small.type, upsert: false });
  if (error) throw new Error("The photo didn't upload. Check your connection and try again.");
  return supabase.storage.from("photos").getPublicUrl(path).data.publicUrl;
}

/** Show the whole photo (click to pick the face) and the card preview, at the current crop point. */
function showCropEditor(src) {
  $("crop-wrap").hidden = !src;
  $("crop-hint").hidden = !src;
  if (!src) return;
  $("crop-full-img").src = src;
  $("i-photo-preview").src = src;
  drawCropPoint();
}

function drawCropPoint() {
  const { x, y } = state.focus;
  $("crop-dot").style.left = `${x}%`;
  $("crop-dot").style.top = `${y}%`;
  $("i-photo-preview").style.objectPosition = `${x}% ${y}%`;
}

$("crop-full-img").addEventListener("click", (event) => {
  const box = event.target.getBoundingClientRect();
  state.focus = focusFromClick(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
  drawCropPoint();
});

$("i-photo").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  const problem = photoProblem(file);
  $("ie-photo").textContent = problem;
  if (file && !problem) {
    state.focus = { ...DEFAULT_FOCUS };
    showCropEditor(URL.createObjectURL(file));
  }
});

$("item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const result = validateItem({ name: form.elements.name.value, badge: form.elements.badge.value, note: form.elements.note.value, story: form.elements.story.value });
  const file = form.elements.photo.files?.[0];
  const photoError = photoProblem(file);
  showErrors("ie-", { ...result.errors, ...(photoError ? { photo: photoError } : {}) });
  if (!result.ok || photoError) return;
  $("item-save").disabled = true;
  $("item-save").textContent = file ? "Shrinking and uploading…" : "Saving…";
  try {
    const row = {
      name: result.values.name,
      badge: result.values.badge || null,
      note: result.values.note || null,
      story: result.values.story || null,
      more_photos: state.morePhotos.slice(0, MORE_PHOTOS_MAX),
      photo_focus_x: state.focus.x,
      photo_focus_y: state.focus.y,
    };
    if (file) row.photo_url = await uploadPhoto(file);
    const query = state.editing
      ? supabase.from("follow_items").update(row).eq("id", state.editing.id)
      : supabase.from("follow_items").insert({ ...row, nonprofit_id: state.nonprofit.id, sort_order: state.items.length });
    const { error } = await query;
    if (error) throw new Error(error.code === "23505" ? "You already have one with that name." : "That didn't save. Please try again.");
    $("item-dialog").close();
    toast(state.editing ? "Saved" : `${result.values.name} added`);
    await reload();
  } catch (error) {
    $("ie-form").textContent = error.message;
  } finally {
    $("item-save").disabled = false;
    $("item-save").textContent = "Save";
  }
});

// ---------- more photos and the longer story (each one's own page, Nov 22) ----------

/** The extra photos in the edit box, each with a remove button. */
function drawMorePhotos() {
  $("more-photos").replaceChildren(...state.morePhotos.map((url, index) => {
    const box = el("div", "more-photo");
    const img = el("img");
    img.src = url;
    img.alt = `More photo ${index + 1}`;
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove photo ${index + 1}`);
    remove.addEventListener("click", () => {
      state.morePhotos.splice(index, 1);
      drawMorePhotos();
    });
    box.append(img, remove);
    return box;
  }));
  $("i-more").disabled = state.morePhotos.length >= MORE_PHOTOS_MAX;
}

$("i-more").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  event.target.value = "";
  const room = MORE_PHOTOS_MAX - state.morePhotos.length;
  const errors = [];
  if (files.length > room) errors.push(`Only ${MORE_PHOTOS_MAX} extra photos fit, so the last ${files.length - room} weren't added.`);
  $("item-save").disabled = true;
  for (const [index, file] of files.slice(0, Math.max(0, room)).entries()) {
    const problem = photoProblem(file);
    if (problem) {
      errors.push(`${file.name}: ${problem}`);
      continue;
    }
    $("ie-more").textContent = `Adding photo ${index + 1}…`;
    try {
      state.morePhotos.push(await uploadPhoto(file));
      drawMorePhotos();
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  $("item-save").disabled = false;
  $("ie-more").textContent = errors.join(" ");
});

$("i-story").addEventListener("input", (event) => {
  $("i-story-count").textContent = event.target.value.length;
});

// ---------- add many photos at once ----------

/** A name nobody else on this page has yet: "Bella", or "Bella 2" if taken. */
function freeName(wanted, taken) {
  const base = wanted || `${singular()} ${taken.size + 1}`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

$("bulk-photos").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  event.target.value = "";
  if (!files.length) return;
  const status = $("bulk-status");
  status.hidden = false;
  const taken = new Set(state.items.map((item) => item.name.toLowerCase()));
  const failed = [];
  let added = 0;
  for (const [index, file] of files.entries()) {
    status.textContent = `Adding photo ${index + 1} of ${files.length}…`;
    const problem = photoProblem(file);
    if (problem) {
      failed.push(`${file.name}: ${problem}`);
      continue;
    }
    try {
      const photoUrl = await uploadPhoto(file);
      const { error } = await supabase.from("follow_items").insert({
        nonprofit_id: state.nonprofit.id,
        name: freeName(nameFromFile(file.name), taken),
        photo_url: photoUrl,
        photo_focus_x: DEFAULT_FOCUS.x,
        photo_focus_y: DEFAULT_FOCUS.y,
        sort_order: state.items.length + index,
      });
      if (error) throw new Error("couldn't save");
      added += 1;
    } catch (error) {
      failed.push(`${file.name}: ${error.message}`);
    }
  }
  await reload();
  status.textContent = `${added} added. Click Edit on each to fix the name, add a line about them, and check the crop.` +
    (failed.length ? ` ${failed.length} didn't work: ${failed.join(" · ")}` : "");
});

function openFinish(item) {
  state.finishing = item;
  $("finish-form").reset();
  const adopted = state.nonprofit.kind === "animal";
  $("finish-title").textContent = adopted ? `Did ${item.name} go home?` : `Wrap up ${item.name}?`;
  $("finish-save").textContent = adopted ? `Yes, ${item.name} was adopted` : "Mark finished";
  $("finish-save").disabled = false;
  $("finish-error").textContent = "";
  // Sponsors are never moved automatically: they're emailed the news and asked if they'd like a new buddy.
  $("finish-explain").textContent = `We'll email ${item.name}'s sponsors the news and ask if they'd like to follow someone new. Until they pick, they follow your whole page.`;
  $("finish-dialog").showModal();
}

async function setItemStatus(item, status, note) {
  const { error } = await supabase.from("follow_items").update({ status, finished_note: note }).eq("id", item.id);
  if (error) {
    toast("That didn't save. Please try again.");
    return;
  }
  toast(status === "finished" ? `${item.name} marked finished` : `${item.name} is back on your page`);
  await reload();
}

// "Mark adopted / Mark finished" runs on Cover's server: it moves the sponsors and emails them.
$("finish-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = state.finishing;
  const note = event.target.elements.note.value.trim().slice(0, 300);
  $("finish-save").disabled = true;
  $("finish-save").textContent = "Saving…";
  try {
    const result = await callServer("sponsor-email", {
      action: "finish", itemId: item.id, note,
    });
    $("finish-dialog").close();
    toast(finishSummary(item.name, result));
    await reload();
  } catch (error) {
    $("finish-save").disabled = false;
    $("finish-save").textContent = state.nonprofit.kind === "animal" ? `Yes, ${item.name} was adopted` : "Mark finished";
    $("finish-error").textContent = error.message;
  }
});

// ---------- post an update (photo + one line, emailed to that one's sponsors) ----------

function drawUpdatePhoto() {
  const src = state.updatePhoto;
  $("u-photo-preview").hidden = !src;
  if (src) $("u-photo-preview").src = src;
  $("u-photo-empty").hidden = Boolean(src);
  $("u-photo-remove").hidden = !src;
  $("u-photo-pick").textContent = src ? "Change photo" : "Add photo";
}

function openPostUpdate(item) {
  state.updating = item;
  state.updatePhoto = "";
  $("update-form").reset();
  $("u-count").textContent = "0";
  ["u-text-error", "u-photo-error", "update-error"].forEach((id) => ($(id).textContent = ""));
  const reach = updateAudience(state.sponsors, item.id);
  $("update-title").textContent = `Post an update about ${item.name}`;
  $("update-sub").textContent = reach
    ? `It goes to ${item.name}'s ${reach} sponsor${reach === 1 ? "" : "s"} by email.`
    : `${item.name} has no sponsors with updates on yet. It'll be saved for later.`;
  $("update-send").disabled = false;
  $("update-send").textContent = "Send update";
  drawUpdatePhoto();
  $("update-dialog").showModal();
  $("u-text").focus();
}

$("u-text").addEventListener("input", () => ($("u-count").textContent = String($("u-text").value.length)));

$("u-photo-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  $("u-photo-error").textContent = photoProblem(file) ?? "";
  if ($("u-photo-error").textContent) return;
  $("u-photo-pick").textContent = "Uploading…";
  $("update-send").disabled = true;
  try {
    state.updatePhoto = await uploadPhoto(file);
  } catch (error) {
    $("u-photo-error").textContent = error.message;
  }
  $("update-send").disabled = false;
  drawUpdatePhoto();
});

$("u-photo-remove").addEventListener("click", () => {
  state.updatePhoto = "";
  drawUpdatePhoto();
});

$("update-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = state.updating;
  const text = $("u-text").value.trim();
  $("u-text-error").textContent = text ? "" : "Write one line about them first.";
  if (!text) return;
  $("update-send").disabled = true;
  $("update-send").textContent = "Sending…";
  try {
    const result = await callServer("sponsor-email", { action: "post", itemId: item.id, text, photoUrl: state.updatePhoto || null });
    $("update-dialog").close();
    toast(postSummary(item.name, result));
  } catch (error) {
    $("update-send").disabled = false;
    $("update-send").textContent = "Send update";
    $("update-error").textContent = error.message;
  }
});

// ---------- your page ----------

function fillPageForm() {
  const np = state.nonprofit;
  const form = $("page-form");
  form.elements.name.value = np.name;
  form.elements.headline.value = np.page?.headline ?? "";
  form.elements.lead.value = np.page?.lead ?? "";
  form.elements.navLabel.value = np.page?.navLabel ?? "";
  form.elements.everyone.value = np.page?.everyone ?? "";
  form.elements.price.value = np.monthly_price_cents / 100;
  form.elements.goal.value = np.monthly_goal_cents / 100;
  // Look and feel
  form.elements.brandColor.value = np.page?.brandColor ?? "";
  form.elements.thanks.value = np.page?.thanks ?? "";
  form.elements.website.value = np.page?.website ?? "";
  form.elements.instagram.value = np.page?.instagram ?? "";
  form.elements.facebook.value = np.page?.facebook ?? "";
  state.look = { logo: safeImageUrl(np.page?.logo), coverPhoto: safeImageUrl(np.page?.coverPhoto) };
  drawLookPreviews();
  drawSwatches();
}

/** Show the chosen logo and cover photo (or the empty boxes). */
function drawLookPreviews() {
  for (const [key, prefix] of [["logo", "logo"], ["coverPhoto", "cover"]]) {
    const src = state.look[key];
    $(`${prefix}-preview`).hidden = !src;
    if (src) $(`${prefix}-preview`).src = src;
    $(`${prefix}-empty`).hidden = Boolean(src);
    $(`${prefix}-remove`).hidden = !src;
    $(`${prefix}-pick`).textContent = src ? (key === "logo" ? "Change logo" : "Change photo") : (key === "logo" ? "Upload logo" : "Upload photo");
  }
}

/** The color circles; the one matching the color box is marked. Picking one previews it right away. */
function drawSwatches() {
  const current = normalizeHex($("p-color").value) ?? "#22C67A";
  $("swatches").replaceChildren(...BRAND_SWATCHES.map((color) => {
    const button = el("button", "swatch");
    button.type = "button";
    button.style.background = color;
    button.setAttribute("aria-label", `Use ${color}`);
    button.setAttribute("aria-pressed", String(color === current));
    button.addEventListener("click", () => {
      $("p-color").value = color;
      previewColor();
    });
    return button;
  }));
}

function previewColor() {
  applyBrand(document.body, $("p-color").value);
  drawSwatches();
}

$("p-color").addEventListener("input", () => {
  if (normalizeHex($("p-color").value) || !$("p-color").value.trim()) previewColor();
});

/** Upload a picked logo or cover photo; it's saved to the page with "Save changes". */
function wireLookUpload(key, prefix) {
  $(`${prefix}-file`).addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const errorBox = $(`pe-${prefix}`);
    errorBox.textContent = photoProblem(file) ?? "";
    if (errorBox.textContent) return;
    $(`${prefix}-pick`).textContent = "Uploading…";
    try {
      state.look[key] = await uploadPhoto(file, { logo: key === "logo" });
      toast(key === "logo" ? "Logo added. Click Save changes to keep it." : "Photo added. Click Save changes to keep it.");
    } catch (error) {
      errorBox.textContent = error.message;
    }
    drawLookPreviews();
  });
  $(`${prefix}-remove`).addEventListener("click", () => {
    state.look[key] = "";
    drawLookPreviews();
  });
}
wireLookUpload("logo", "logo");
wireLookUpload("coverPhoto", "cover");

$("page-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form));
  const result = validatePage(fields);
  const look = validateLook(fields);
  showErrors("pe-", { ...result.errors, ...look.errors });
  if (!result.ok || !look.ok) {
    form.querySelector(".field-error:not(:empty)")?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const { values } = result;
  const page = { ...(state.nonprofit.page ?? {}) };
  const chosen = { ...values, ...look.values, logo: state.look.logo, coverPhoto: state.look.coverPhoto };
  for (const key of ["headline", "lead", "navLabel", "everyone", "brandColor", "thanks", "website", "instagram", "facebook", "logo", "coverPhoto"]) {
    if (chosen[key]) page[key] = chosen[key];
    else delete page[key];
  }
  const { error } = await supabase.from("nonprofits")
    .update({ name: values.name, page, monthly_price_cents: values.priceCents, monthly_goal_cents: values.goalCents })
    .eq("id", state.nonprofit.id);
  if (error) {
    $("pe-form").textContent = "That didn't save. Please try again.";
    return;
  }
  $("page-saved").hidden = false;
  setTimeout(() => ($("page-saved").hidden = true), 2500);
  await reload();
});

// ---------- connect Stripe ----------

async function drawConnect() {
  const status = await refreshStripeStatus();
  $("connect-status").textContent = status?.message ?? "Fill in the form below. The law requires checking who receives donations, so donors can trust where their money goes.";
  if (state.nonprofit.is_live) {
    $("connect-title").textContent = "Payouts are set up";
    $("onboarding-mount").replaceChildren();
    return;
  }
  if (state.role === "admin" && !$("helper-note")) {
    const note = el("div", "helper-note", "You're helping run this page. Payouts are best set up by the nonprofit's owner, because Stripe checks the identity of whoever fills this in. Invite them from Settings.");
    note.id = "helper-note";
    $("onboarding-mount").before(note);
  }
  mountStripe("account-onboarding", "onboarding-mount", (onboarding) => {
    onboarding.setOnExit(async () => {
      const result = await refreshStripeStatus();
      toast(result?.live ? "You're approved. Your page is live!" : "Saved. We're verifying your details.");
      await reload();
      show(result?.live ? "overview" : "connect");
    });
  });
}

// ---------- copy link, navigation, sign out ----------

async function copyLink() {
  try {
    await navigator.clipboard.writeText(publicUrl());
    toast("Page link copied");
  } catch {
    toast(publicUrl());
  }
  try {
    localStorage.setItem(linkSharedKey(), "yes");
  } catch {
    // remembering is optional
  }
  drawOverview();
}

function show(view) {
  if (view === "connect" && state.nonprofit.is_live) view = "overview";
  document.querySelectorAll("[data-view]").forEach((section) => (section.hidden = section.dataset.view !== view));
  document.querySelectorAll(".side [data-nav]").forEach((link) => link.classList.toggle("on", link.dataset.nav === view));
  history.replaceState(null, "", `#${view}`);
  window.scrollTo(0, 0);
  if (view === "connect") drawConnect();
  if (view === "payments" || view === "settings") {
    if (!hasStripeAccount()) {
      const target = view === "payments" ? "payments-mount" : "account-mount";
      const note = el("p", "empty", "Set up payouts first, then your payments and bank details show here.");
      const go = el("button", "btn btn-primary", "Set up payouts");
      go.type = "button";
      go.addEventListener("click", () => show("connect"));
      $(target).replaceChildren(note, go);
      if (view === "payments") $("payouts-mount").replaceChildren();
    } else if (view === "payments") {
      mountStripe("payments", "payments-mount");
      mountStripe("payouts", "payouts-mount");
    } else {
      mountStripe("account-management", "account-mount");
    }
  }
}

document.querySelectorAll("[data-nav]").forEach((link) => link.addEventListener("click", (event) => {
  event.preventDefault();
  show(link.dataset.nav);
}));
document.querySelectorAll("[data-copy-link]").forEach((button) => button.addEventListener("click", copyLink));
$("add-item").addEventListener("click", () => openItem(null));
$("item-close").addEventListener("click", () => $("item-dialog").close());
$("finish-close").addEventListener("click", () => $("finish-dialog").close());
$("update-close").addEventListener("click", () => $("update-dialog").close());
$("welcome-close").addEventListener("click", () => $("welcome-dialog").close());
$("welcome-download").addEventListener("click", downloadWelcome);
$("welcome-copy").addEventListener("click", copyWelcomeCaption);
$("sign-out").addEventListener("click", async () => {
  await supabase.auth.signOut();
  location.replace(pageUrl("signin.html"));
});

function drawAll() {
  const np = state.nonprofit;
  document.title = `${np.name} | Cover`;
  $("org-name").textContent = np.name;
  $("org-initials").textContent = np.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  // Their own logo and color, if they've set them.
  const logo = safeImageUrl(np.page?.logo);
  $("org-logo").hidden = !logo;
  $("org-initials").hidden = Boolean(logo);
  if (logo) $("org-logo").src = logo;
  applyBrand(document.body, np.page?.brandColor);
  $("me").textContent = state.user.email;
  // Cover's 3% fee: told upfront in setup and on the payments screen, only once Cover switches it on.
  document.querySelectorAll("[data-fee-note]").forEach((note) => (note.hidden = np.cover_fee_on !== true));
  drawOverview();
  drawSponsors();
  drawItems();
  fillPageForm();
  drawTeam();
  drawAdminTools();
  if (hasStripeAccount()) mountStripe("notification-banner", "banner-mount");
}

// ---------- people who run this page ----------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function drawTeam() {
  const { data: invites } = await supabase.from("staff_invites").select("email, role").eq("nonprofit_id", state.nonprofit.id);
  const rows = [{ email: state.user.email, role: state.role, you: true }, ...(invites ?? []).map((i) => ({ ...i, pending: true }))];
  const head = el("tr");
  ["Person", "Role", "Status", ""].forEach((h) => head.append(el("th", "", h)));
  $("team").replaceChildren(head, ...rows.map((row) => {
    const tr = el("tr");
    tr.append(el("td", "", row.email), el("td", "", row.role === "owner" ? "Owner" : "Helper"),
      el("td", "", row.you ? "You" : "Invited, hasn't signed in yet"));
    const action = el("td");
    if (row.pending) {
      const cancel = el("button", "link-btn", "Cancel invite");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        await supabase.rpc("cancel_invite", { target: state.nonprofit.id, invite_email: row.email });
        drawTeam();
      });
      action.append(cancel);
    }
    tr.append(action);
    return tr;
  }));
}

/** The message Tanner sends the owner (copied for him). */
function inviteMessage(email) {
  return `Hi! I set up a monthly sponsor page for ${state.nonprofit.name} on Cover. To finish, go to ${pageUrl("signin.html")} ` +
    `and sign in with ${email}. You'll land on one short step: setting up payouts so donations go to your bank. ` +
    `It takes about 10 minutes. Have these ready: your EIN, your bank login (or routing and account numbers), a photo ID, ` +
    `and 5 or so ${state.nonprofit.kind === "animal" ? "photos of your animals" : "photos of your programs"} on your phone. ` +
    `Your page: ${publicUrl()}`;
}

async function sendInvite(email, role) {
  const { error } = await supabase.rpc("invite_to_nonprofit", { target: state.nonprofit.id, invite_email: email, invite_role: role });
  if (error) throw new Error(error.code === "P0001" ? error.message : "That invite didn't save. Please try again.");
  const text = inviteMessage(email);
  $("invite-text").value = text;
  $("invite-message").hidden = false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // the message is still shown to copy by hand
  }
  drawTeam();
}

$("invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = event.target.elements.email.value.trim().toLowerCase();
  $("inv-error").textContent = "";
  if (!EMAIL_PATTERN.test(email)) {
    $("inv-error").textContent = "That email doesn't look right.";
    return;
  }
  try {
    await sendInvite(email, event.target.elements.role.value);
    event.target.reset();
  } catch (error) {
    $("inv-error").textContent = error.message;
  }
});

// ---------- Cover admin tools ----------

function drawAdminTools() {
  $("admin-tools").hidden = !state.admin;
  if (!state.admin) return;
  $("np-switch").replaceChildren(...state.memberships.map((m) => {
    const option = el("option", "", m.name);
    option.value = m.nonprofit_id;
    option.selected = m.nonprofit_id === state.nonprofit.id;
    return option;
  }));
}

function rememberNonprofit(id) {
  try {
    localStorage.setItem("cover.currentNonprofit", id);
  } catch {
    // remembering is optional
  }
}

function rememberedNonprofit() {
  try {
    return localStorage.getItem("cover.currentNonprofit");
  } catch {
    return null;
  }
}

$("np-switch").addEventListener("change", (event) => {
  rememberNonprofit(event.target.value);
  location.reload(); // payment screens belong to one nonprofit at a time
});
$("new-nonprofit").addEventListener("click", () => openCreate(true));
$("create-cancel").addEventListener("click", () => {
  $("create").hidden = true;
  $("app").hidden = false;
});


async function reload() {
  await loadNonprofit(state.nonprofit.id);
  drawAll();
}

// ---------- first visit: create the nonprofit ----------

let slugEdited = false;
$("c-name").addEventListener("input", () => {
  if (!slugEdited) $("c-slug").value = slugify($("c-name").value);
  $("c-slug-preview").textContent = `${pageUrl("give.html")}?org=${$("c-slug").value || "your-link"}`;
});
$("c-slug").addEventListener("input", () => {
  slugEdited = true;
  $("c-slug-preview").textContent = `${pageUrl("give.html")}?org=${$("c-slug").value || "your-link"}`;
});
$("c-kind").addEventListener("change", (event) => {
  if (!$("c-label").dataset.edited) $("c-label").value = event.target.value === "animal" ? "Animals" : "Programs";
});
$("c-label").addEventListener("input", (event) => (event.target.dataset.edited = "yes"));

/** Show the create form, for your own nonprofit or (Cover admins) for someone else's. */
function openCreate(forSomeone) {
  state.creatingFor = forSomeone ? "someone" : "self";
  $("create-title").textContent = forSomeone ? "Set up a page for a nonprofit" : "Set up your sponsor page";
  $("create-lead").textContent = forSomeone
    ? "You'll add their dogs or programs and photos. Invite the owner and their only job is setting up payouts."
    : "A few basics. You can change all of this later.";
  $("create-submit").textContent = forSomeone ? "Create the page" : "Create my page";
  $("c-owner-group").hidden = !forSomeone;
  $("create-cancel").hidden = !forSomeone;
  $("create-form").reset();
  slugEdited = false;
  $("c-slug-preview").textContent = `${pageUrl("give.html")}?org=your-link`;
  $("app").hidden = true;
  $("create").hidden = false;
  $("c-name").focus();
}

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.target));
  const result = validateSignup(form);
  const ownerEmail = (form.ownerEmail ?? "").trim().toLowerCase();
  const ownerError = ownerEmail && !EMAIL_PATTERN.test(ownerEmail) ? "That email doesn't look right." : "";
  showErrors("ce-", { ...result.errors, ...(ownerError ? { ownerEmail: ownerError } : {}) });
  if (!result.ok || ownerError) return;
  $("create-submit").disabled = true;
  const { values } = result;
  const forSomeone = state.creatingFor === "someone";
  const { data, error } = await supabase.rpc(forSomeone ? "admin_create_nonprofit" : "create_my_nonprofit", {
    nonprofit_name: values.name,
    page_slug: values.slug,
    page_kind: values.kind,
    follow_label: values.followLabel,
    price_cents: values.priceCents,
    goal_cents: values.goalCents,
  });
  $("create-submit").disabled = false;
  if (error) {
    $("ce-form").textContent = error.code === "P0001" ? error.message : "That didn't work. Please try again.";
    return;
  }
  if (forSomeone) {
    rememberNonprofit(data);
    if (ownerEmail) await supabase.rpc("invite_to_nonprofit", { target: data, invite_email: ownerEmail, invite_role: "owner" });
    location.hash = "items"; // next: add their dogs or programs
    location.reload();
    return;
  }
  await start();
});

// ---------- start ----------

async function start() {
  // Arriving from the sign-in email: check its one-time token first. A bad or used link goes back to
  // the sign-in page with a clear message, instead of silently asking to sign in again.
  const linkResult = await finishSignInFromLink(supabase);
  if (linkResult === "expired" || linkResult === "failed") {
    location.replace(`${pageUrl("signin.html")}?problem=${linkResult}`);
    return;
  }
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    location.replace(pageUrl("signin.html"));
    return;
  }
  state.user = data.session.user;
  // Save their "I agree to the Terms" from the sign-in page on Cover's records (doesn't block loading).
  recordTermsAgreement(supabase, state.user).catch(() => {});
  // Turn any invites for this email into access first (an owner invited by Cover lands here).
  const claimed = (await supabase.rpc("claim_my_invites")).data ?? 0;
  const [memberships, admin] = await Promise.all([
    supabase.from("staff").select("nonprofit_id, role, nonprofits(name)").order("created_at"),
    supabase.rpc("am_i_cover_admin"),
  ]);
  $("loading").hidden = true;
  if (memberships.error) {
    $("loading").hidden = false;
    $("loading").textContent = "Couldn't load your dashboard. Refresh to try again.";
    return;
  }
  state.admin = admin.data === true;
  state.memberships = memberships.data.map((m) => ({ nonprofit_id: m.nonprofit_id, role: m.role, name: m.nonprofits?.name ?? "Nonprofit" }));
  if (!state.memberships.length) {
    openCreate(state.admin);
    $("create-cancel").hidden = true;
    return;
  }
  const remembered = rememberedNonprofit();
  const current = state.memberships.find((m) => m.nonprofit_id === remembered) ?? state.memberships[0];
  state.role = current.role;
  $("create").hidden = true;
  await loadNonprofit(current.nonprofit_id);
  if (hasStripeAccount() && !state.nonprofit.is_live) await refreshStripeStatus();
  $("app").hidden = false;
  drawAll();
  if (claimed) toast(`Welcome! You now run ${state.nonprofit.name} on Cover.`);
  // An owner whose payouts aren't set up yet starts there: it's their one job.
  const firstJob = state.role === "owner" && !state.nonprofit.is_live ? "connect" : "overview";
  const wanted = location.hash.replace("#", "");
  show(document.querySelector(`[data-view="${wanted}"]`) && wanted !== "overview" ? wanted : firstJob);
}

start().catch((error) => {
  console.error(error);
  $("loading").hidden = false;
  $("loading").textContent = "Couldn't load your dashboard. Refresh to try again.";
});
