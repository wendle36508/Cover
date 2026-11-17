// hq-logic.js - turns Cover HQ's numbers into tiles and plain-English alerts. Pure functions, tested.

const dollars = (cents) => "$" + Math.round((Number(cents) || 0) / 100).toLocaleString("en-US");

/** The big numbers across the top of HQ. warn = shown in amber when above zero. */
export function hqTiles(totals) {
  const t = totals ?? {};
  return [
    { label: "Live pages", value: `${t.live_pages ?? 0} of ${t.nonprofits ?? 0}` },
    { label: "Active sponsors", value: String(t.active_sponsors ?? 0) },
    { label: "Monthly giving", value: dollars(t.monthly_cents) },
    { label: "New sponsors (7 days)", value: String(t.new_sponsors_7d ?? 0) },
    { label: "Cards failed", value: String(t.card_failed ?? 0), warn: (t.card_failed ?? 0) > 0 },
    { label: "Disputes / refunds to review", value: String(t.needs_review ?? 0), warn: (t.needs_review ?? 0) > 0 },
    { label: "Owners invited, not joined", value: String(t.pending_invites ?? 0), warn: (t.pending_invites ?? 0) > 0 },
    { label: "Canceled (30 days)", value: String(t.canceled_30d ?? 0) },
  ];
}

/** Plain-English things to act on, worst first. Returns [{ level: "bad"|"warn"|"ok", text }]. */
export function hqAlerts(data) {
  const alerts = [];
  const t = data?.totals ?? {};
  if ((t.needs_review ?? 0) > 0) {
    alerts.push({ level: "bad", text: `${t.needs_review} dispute, refund or fraud warning to look at. The nonprofit sees it in Payments & payouts.` });
  }
  for (const n of data?.nonprofits ?? []) {
    if (n.invite_pending && !n.owner_joined) {
      alerts.push({ level: "warn", text: `${n.name}: owner invited but hasn't signed in yet. Send a reminder.` });
    } else if (n.owner_joined && !n.payouts_started) {
      alerts.push({ level: "warn", text: `${n.name}: owner joined but hasn't started payouts setup.` });
    } else if (n.payouts_started && !n.is_live) {
      alerts.push({ level: "warn", text: `${n.name}: payouts started, waiting on verification. Their page isn't live yet.` });
    }
    if (n.is_live && n.things_to_follow === 0) {
      alerts.push({ level: "warn", text: `${n.name}: page is live but has nothing to follow. Add dogs or programs.` });
    } else if (n.things_to_follow > 0 && n.with_photos < n.things_to_follow) {
      alerts.push({ level: "warn", text: `${n.name}: ${n.things_to_follow - n.with_photos} without a photo.` });
    }
  }
  if ((t.card_failed ?? 0) > 0) {
    alerts.push({ level: "warn", text: `${t.card_failed} sponsor card${t.card_failed === 1 ? "" : "s"} failed. Stripe retries and emails them automatically.` });
  }
  return alerts.length ? alerts : [{ level: "ok", text: "All clear. Nothing needs you right now." }];
}

/** Friendly names for the Stripe events HQ shows. */
export function eventLabel(type) {
  return {
    "charge.dispute.created": "A donor disputed a charge",
    "charge.refunded": "A gift was refunded",
    "radar.early_fraud_warning.created": "Possible fraud warning",
  }[type] ?? type;
}

export { dollars };

// ---------- Nonprofit data (the walled-off insights section) ----------

const SOURCE_NAMES = {
  irs_bmf: "IRS registry (BMF)",
  irs_pub78: "Pub 78 (tax-deductible)",
  irs_revocations: "Revocations",
  irs_990n: "990-N postcards",
};
export const STALE_DAYS = 40; // the import runs monthly; older than this means it missed a run

/** One row of the sources table: name, IRS file date, rows, last run, status text and tone. */
export function sourceRow(source, now = new Date()) {
  const finished = source?.finished_at ? new Date(source.finished_at) : null;
  const ageDays = finished ? (now - finished) / 86400000 : Infinity;
  let status = { text: "Never run", tone: "warn" };
  if (source?.status === "running") status = { text: "Running", tone: "ok" };
  else if (source?.status === "failed") status = { text: "Failed", tone: "bad" };
  else if (source?.status === "done") status = ageDays > STALE_DAYS ? { text: "Out of date", tone: "warn" } : { text: "Up to date", tone: "ok" };
  return {
    name: SOURCE_NAMES[source?.source] ?? source?.source ?? "",
    fileDate: source?.file_date ?? "—",
    rows: Number(source?.rows_loaded ?? 0).toLocaleString("en-US"),
    lastRun: finished ? finished.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—",
    status,
    note: source?.note ?? "",
  };
}

/** Plain-English result of an EIN check. Returns { tone, text }. */
export function einCheckText(result) {
  const r = result ?? {};
  const where = [r.city, r.state].filter(Boolean).join(", ");
  const who = r.name ? `${r.name}${where ? ` (${where})` : ""}` : `EIN ${r.ein ?? ""}`;
  switch (r.status) {
    case "good":
      return { tone: "ok", text: `${who} is a 501(c)(3) in good standing and can receive tax-deductible gifts.` };
    case "not_in_pub78":
      return { tone: "warn", text: `${who} is in the IRS registry but not on Pub 78, so gifts may not be tax-deductible. Ask them.` };
    case "revoked":
      return { tone: "bad", text: `EIN ${r.ein} lost its tax-exempt status on ${r.revoked_on ?? "an unknown date"}. Don't put its page live.` };
    case "not_found":
      return { tone: "warn", text: `EIN ${r.ein} isn't in the IRS registry of public charities. It may be a church, a private foundation, brand new, or a typo.` };
    default:
      return { tone: "bad", text: "That doesn't look like an EIN. It's 9 digits, like 12-3456789." };
  }
}

/** Check a benchmark edit before saving. Returns { ok, errors, values }. */
export function validateBenchmark(form) {
  const text = (value) => String(value ?? "").trim();
  const values = {
    id: text(form?.id), label: text(form?.label), value: text(form?.value), definition: text(form?.definition),
    source_name: text(form?.source_name), source_url: text(form?.source_url), as_of: text(form?.as_of),
    sort_order: Number.parseInt(form?.sort_order, 10) || 0,
  };
  const errors = {};
  for (const field of ["label", "value", "definition", "source_name"]) if (!values[field]) errors[field] = "Required.";
  if (!/^https:\/\/\S+$/.test(values.source_url)) errors.source_url = "Use a full https:// link.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.as_of) || Number.isNaN(Date.parse(values.as_of))) errors.as_of = "Use a date like 2026-10-29.";
  if (!/^[a-z0-9_]{3,60}$/.test(values.id)) errors.id = "Lowercase letters, numbers and _ only.";
  return { ok: Object.keys(errors).length === 0, errors, values };
}

