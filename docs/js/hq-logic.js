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
