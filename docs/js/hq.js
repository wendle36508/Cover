// hq.js - Cover HQ: live numbers for Cover admins. Refreshes every minute.
// The database only answers admins (admin_overview), so this page shows nothing to anyone else.

import { whenText } from "./dashboard-logic.js";
import { dollars, einCheckText, eventLabel, hqAlerts, hqTiles, sourceRow, validateBenchmark } from "./hq-logic.js";
import { pageUrl, supabase } from "./supabase.js";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 60000;
const STATUS_TEXT = { active: "Active", pending: "Waiting on payment", past_due: "Card failed", canceled: "Canceled" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function row(cells, header = false) {
  const tr = el("tr");
  for (const cell of cells) {
    const td = el(header ? "th" : "td");
    if (cell instanceof Node) td.append(cell);
    else td.textContent = cell;
    tr.append(td);
  }
  return tr;
}

function yesNo(value, yes = "Yes", no = "No") {
  return el("span", value ? "yes" : "no", value ? yes : no);
}

function draw(data) {
  $("updated").textContent = `Updated ${new Date(data.generated_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  $("tiles").replaceChildren(...hqTiles(data.totals).map((tile) => {
    const box = el("div", `hq-tile${tile.warn ? " warn" : ""}`);
    box.append(el("span", "", tile.label), el("b", "", tile.value));
    return box;
  }));

  const nonprofits = data.nonprofits ?? [];
  $("nonprofits").replaceChildren(row(["Nonprofit", "Live", "Owner", "Payouts", "Following", "Sponsors", "Monthly"], true),
    ...(nonprofits.length ? nonprofits.map((n) => {
      const name = el("a", "", n.name);
      name.href = `${pageUrl("give.html")}?org=${n.slug}`;
      name.target = "_blank";
      return row([
        name,
        yesNo(n.is_live, "Live", "Not yet"),
        yesNo(n.owner_joined, "Joined", n.invite_pending ? "Invited" : "None"),
        yesNo(n.payouts_started, "Started", "Not started"),
        `${n.things_to_follow} (${n.with_photos} with photos)`,
        String(n.active_sponsors),
        dollars(n.monthly_cents),
      ]);
    }) : [row(["No nonprofits yet. Create one from your dashboard."])]));

  const sponsors = data.recent_sponsors ?? [];
  $("sponsors").replaceChildren(row(["Sponsor", "Nonprofit", "Following", "Monthly", "Status", "When"], true),
    ...(sponsors.length ? sponsors.map((s) => row([
      `${s.name}${s.business ? " (business)" : ""}`,
      s.nonprofit,
      s.following ?? "—",
      dollars(s.monthly_cents),
      STATUS_TEXT[s.status] ?? s.status,
      whenText(s.created_at),
    ])) : [row(["No sponsors yet."])]));

  $("alerts").replaceChildren(...hqAlerts(data).map((alert) => el("li", alert.level, alert.text)));

  const events = data.review_events ?? [];
  $("events").replaceChildren(...(events.length
    ? events.map((e) => row([eventLabel(e.type), whenText(e.received_at)]))
    : [row(["Nothing to review."])]));
}

// ---------- Nonprofit data ----------

let benchmarks = [];

function drawData(status) {
  $("data-panel").hidden = false;
  const n = (value) => Number(value ?? 0).toLocaleString("en-US");
  $("data-counts").textContent = `${n(status.orgs)} public charities on file · ${n(status.prospects)} with $50K to $10M revenue · ${n(status.revocations)} revoked`;
  $("data-sources").replaceChildren(row(["Source", "IRS file", "Rows", "Last run", "Status"], true),
    ...(status.sources ?? []).map((source) => {
      const r = sourceRow(source);
      const badge = el("span", `tone-${r.status.tone}`, r.status.text);
      if (r.note) badge.title = r.note;
      return row([r.name, r.fileDate, r.rows, r.lastRun, badge]);
    }));
  benchmarks = status.benchmarks ?? [];
  $("benchmarks").replaceChildren(row(["Benchmark", "Number", "Source", "As of", ""], true), ...benchmarks.map((b) => {
    const label = el("div", "", b.label);
    label.append(el("small", "", b.definition));
    const link = el("a", "", b.source_name);
    link.href = b.source_url;
    link.target = "_blank";
    link.rel = "noopener";
    const edit = el("button", "mini-btn", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openBenchmark(b));
    return row([label, b.value, link, b.as_of, edit]);
  }));
}

async function loadData() {
  const { data, error } = await supabase.rpc("admin_insights_status");
  if (error) {
    console.warn("Couldn't load nonprofit data", error.message);
    return;
  }
  drawData(data);
}

function openBenchmark(b) {
  const form = $("bench-form");
  for (const [name, value] of Object.entries(b)) if (form.elements[name]) form.elements[name].value = value ?? "";
  form.querySelectorAll("[data-err]").forEach((node) => (node.textContent = ""));
  $("bench-error").textContent = "";
  $("bench-dialog").showModal();
}

$("bench-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const result = validateBenchmark(Object.fromEntries(new FormData(form)));
  form.querySelectorAll("[data-err]").forEach((node) => (node.textContent = result.errors[node.dataset.err] ?? ""));
  if (!result.ok) return;
  const { error } = await supabase.rpc("admin_save_benchmark", { item: result.values });
  if (error) {
    $("bench-error").textContent = "That didn't save. Check the link and date, then try again.";
    return;
  }
  $("bench-dialog").close();
  await loadData();
});
$("bench-close").addEventListener("click", () => $("bench-dialog").close());

$("ein-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const box = $("ein-result");
  box.hidden = false;
  box.className = "ein-result";
  box.textContent = "Checking…";
  const { data, error } = await supabase.rpc("admin_check_ein", { target_ein: $("ein-input").value });
  const result = error ? { tone: "bad", text: "Couldn't check right now. Try again." } : einCheckText(data);
  box.className = `ein-result tone-${result.tone}`;
  box.textContent = result.text;
});

async function load() {
  const { data, error } = await supabase.rpc("admin_overview");
  if (error) {
    $("hq").hidden = true;
    $("denied").hidden = false;
    $("denied-text").textContent = error.code === "42501"
      ? "This account isn't a Cover admin."
      : "Couldn't load HQ. Refresh to try again.";
    return;
  }
  $("denied").hidden = true;
  $("hq").hidden = false;
  draw(data);
  await loadData();
}

async function start() {
  const { data } = await supabase.auth.getSession();
  $("loading").hidden = true;
  if (!data.session) {
    $("denied").hidden = false;
    $("denied-text").textContent = "Sign in with your admin email to see HQ.";
    return;
  }
  await load();
  setInterval(load, REFRESH_MS);
}

$("refresh").addEventListener("click", load);
start();
