// income-chart.js - the dashboard's "Money in" line chart (Tanner, Nov 25, 2026: "a line chart of their
// income... more of a financial dashboard"). One line: the money that actually came in each month
// (payments minus refunds, from the nonprofit's Stripe account). Hover or tap a month for the split
// between sponsorships and one-time gifts. The numbers come from the stripe-connect "income" request.
// chartScale is plain math so Node can test it; drawIncomeChart builds the SVG (text via textContent).

const SVG = "http://www.w3.org/2000/svg";

/** "$1,250" from cents (whole dollars on the chart). */
export function chartDollars(cents) {
  return `$${Math.round((Number(cents) || 0) / 100).toLocaleString("en-US")}`;
}

/** A round top for the axis: 1, 2 or 5 times a power of ten, in cents ($100 when there's no money yet). */
export function niceMax(maxCents) {
  const dollars = Math.max(0, Number(maxCents) || 0) / 100;
  if (dollars <= 0) return 10000;
  const power = 10 ** Math.floor(Math.log10(dollars));
  const step = [1, 2, 5, 10].find((s) => s * power >= dollars) ?? 10;
  return Math.round(step * power * 100);
}

/**
 * Where everything goes. months: [{ label, totalCents, ... }] oldest first.
 * Returns { points: [{ x, y, cents, label }], max, ticks: [{ y, cents }], left, right, top, bottom }.
 */
export function chartScale(months, width = 640, height = 220) {
  const left = 48;
  const right = width - 16;
  const top = 16;
  const bottom = height - 28;
  const list = months ?? [];
  const max = niceMax(Math.max(0, ...list.map((m) => m.totalCents || 0)));
  const span = Math.max(1, list.length - 1);
  const points = list.map((m, i) => ({
    x: left + ((right - left) * i) / span,
    y: bottom - ((bottom - top) * (m.totalCents || 0)) / max,
    cents: m.totalCents || 0,
    label: m.label,
  }));
  const ticks = [0, 0.5, 1].map((share) => ({ y: bottom - (bottom - top) * share, cents: Math.round(max * share) }));
  return { points, max, ticks, left, right, top, bottom, width, height };
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** Draw the chart into `container` (replacing what's there). income: { months, totalCents, thisMonthCents }. */
export function drawIncomeChart(container, income) {
  const months = income?.months ?? [];
  const width = Math.max(320, Math.round(container.clientWidth || 640));
  const narrow = width < 480;
  const s = chartScale(months, width, narrow ? 200 : 220);
  const root = svg("svg", { viewBox: `0 0 ${s.width} ${s.height}`, width: "100%", height: s.height, role: "img",
    "aria-label": `Money in each month for the last ${months.length} months. This month: ${chartDollars(income?.thisMonthCents)}.` });

  for (const tick of s.ticks) {
    root.append(svg("line", { x1: s.left, x2: s.right, y1: tick.y, y2: tick.y, class: "ic-grid" }));
    const label = svg("text", { x: s.left - 8, y: tick.y + 4, "text-anchor": "end", class: "ic-axis" });
    label.textContent = chartDollars(tick.cents);
    root.append(label);
  }
  s.points.forEach((p, i) => {
    if (narrow && i % 3 !== (months.length - 1) % 3) return; // every third month on phones
    const label = svg("text", { x: p.x, y: s.height - 8, "text-anchor": "middle", class: "ic-axis" });
    label.textContent = p.label;
    root.append(label);
  });
  if (s.points.length) {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    root.append(svg("path", { d, class: "ic-line" }));
    const last = s.points[s.points.length - 1];
    root.append(svg("circle", { cx: last.x, cy: last.y, r: 4, class: "ic-dot" }));
    const value = svg("text", { x: last.x - 8, y: Math.max(s.top + 12, last.y - 10), "text-anchor": "end", class: "ic-value" });
    value.textContent = chartDollars(last.cents);
    root.append(value);
  }

  // Hover and tap: a thin line and a readout for the month under the pointer.
  const guide = svg("line", { y1: s.top, y2: s.bottom, class: "ic-guide", visibility: "hidden" });
  const marker = svg("circle", { r: 5, class: "ic-dot", visibility: "hidden" });
  root.append(guide, marker);
  const tip = document.createElement("div");
  tip.className = "ic-tip";
  tip.hidden = true;
  const showMonth = (i) => {
    const p = s.points[i];
    const m = months[i];
    guide.setAttribute("x1", p.x);
    guide.setAttribute("x2", p.x);
    guide.setAttribute("visibility", "visible");
    marker.setAttribute("cx", p.x);
    marker.setAttribute("cy", p.y);
    marker.setAttribute("visibility", "visible");
    tip.replaceChildren();
    const head = document.createElement("b");
    head.textContent = `${m.label} ${m.year ?? ""}: ${chartDollars(m.totalCents)}`.replace(" :", ":");
    const split = document.createElement("span");
    split.textContent = `Sponsorships ${chartDollars(m.sponsorCents)}, one-time gifts ${chartDollars(m.oneTimeCents)}`;
    tip.append(head, split);
    tip.hidden = false;
    const share = p.x / s.width;
    tip.style.left = `${Math.min(80, Math.max(0, share * 100 - 20))}%`;
  };
  const hide = () => {
    guide.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const step = s.points.length > 1 ? s.points[1].x - s.points[0].x : s.right - s.left;
  s.points.forEach((p, i) => {
    const hit = svg("rect", { x: p.x - step / 2, y: s.top, width: step, height: s.bottom - s.top + 20, class: "ic-hit" });
    hit.addEventListener("pointerenter", () => showMonth(i));
    hit.addEventListener("pointerdown", () => showMonth(i));
    root.append(hit);
  });
  root.addEventListener("pointerleave", hide);
  const wrap = document.createElement("div");
  wrap.className = "ic-wrap";
  wrap.append(root, tip);
  container.replaceChildren(wrap);
}
