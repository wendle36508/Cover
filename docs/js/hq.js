// hq.js - Cover HQ: live numbers for Cover admins. Refreshes every minute.
// The database only answers admins (admin_overview), so this page shows nothing to anyone else.

import { whenText } from "./dashboard-logic.js";
import { dollars, eventLabel, hqAlerts, hqTiles } from "./hq-logic.js";
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
