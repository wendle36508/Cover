// dashboard-look.test.js - the owner dashboard in the new look (approved by Tanner, Nov 25, 2026):
// the "Money in" line chart, the phone menu, Cover's own colors and the demo mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chartDollars, chartScale, niceMax } from "../docs/js/income-chart.js";
import { BRAND_SWATCHES } from "../docs/js/brand.js";

const read = (path) => readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8");

test("the chart's axis tops out at a round number above the best month", () => {
  assert.equal(niceMax(0), 10000, "no money yet: a $0 to $100 axis");
  assert.equal(niceMax(1000), 1000, "$10");
  assert.equal(niceMax(23400), 50000, "$234 -> $500");
  assert.equal(niceMax(120000), 200000, "$1,200 -> $2,000");
  assert.equal(niceMax(500000), 500000);
  assert.equal(chartDollars(128500), "$1,285");
  assert.equal(chartDollars(undefined), "$0");
});

test("the line runs left to right, oldest month first, higher money higher up", () => {
  const months = [{ label: "Oct", totalCents: 0 }, { label: "Nov", totalCents: 5000 }, { label: "Dec", totalCents: 10000 }];
  const s = chartScale(months, 640, 220);
  assert.equal(s.points.length, 3);
  assert.equal(s.points[0].x, s.left);
  assert.equal(s.points[2].x, s.right);
  assert.equal(s.points[0].y, s.bottom, "$0 sits on the bottom line");
  assert.equal(s.points[2].y, s.top, "the best month reaches the top");
  assert.ok(s.points[1].y < s.points[0].y && s.points[1].y > s.points[2].y);
  assert.deepEqual(s.ticks.map((t) => t.cents), [0, 5000, 10000]);
  assert.deepEqual(chartScale([], 640, 220).points, [], "no months: nothing to draw, no error");
});

test("the dashboard shows Money in, with a table version, and never its own brand color", () => {
  const html = read("dashboard.html");
  assert.match(html, /<h2>Money in <span class="income-sum" id="income-sum"><\/span><\/h2>/);
  assert.match(html, /<details class="income-table"><summary>See the months as a table<\/summary>/);
  assert.match(html, /css\/dashboard-look\.css\?v=/);
  assert.match(html, /js\/dashboard\.js\?v=/);
  const js = read("js/dashboard.js");
  assert.match(js, /callServer\("stripe-connect", \{ action: "income", nonprofitId: state\.nonprofit\.id \}\)/);
  assert.match(js, /applyBrand\(document\.body, null\)/, "Cover's tool keeps Cover's colors");
  assert.equal(BRAND_SWATCHES[0], "#4B5A2A", "the color picker starts on Cover moss, not the old green");
});

test("phones get their name on top and a bottom menu, and More opens the rest", () => {
  const html = read("dashboard.html");
  assert.match(html, /<header class="phone-top">/);
  assert.match(html, /<nav class="tabbar" aria-label="Dashboard">\s*<a data-nav="overview">Home<\/a><a data-nav="items" id="tab-items-label">Dogs<\/a><a data-nav="sponsors">Sponsors<\/a><button type="button" id="tab-more"/);
  assert.match(html, /<div class="tab-sheet" id="tab-sheet" hidden><a data-nav="page">Your page<\/a><a data-nav="payments">Payments &amp; payouts<\/a><a data-nav="settings">Settings<\/a><\/div>/);
  const css = read("css/dashboard-look.css");
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*\.side \{ display: none; \}[\s\S]*\.tabbar \{ display: grid;/);
});

test("the demo is clearly sample data and never signs in", () => {
  const demo = read("js/dashboard-demo.js");
  assert.match(demo, /export const DEMO = new URLSearchParams\(location\.search\)\.get\("demo"\) === "1";/);
  assert.match(demo, /name: "Harbor Paws Rescue"/, "a sample rescue, never a real nonprofit's name");
  assert.doesNotMatch(demo, /Lucky Pup/);
  const js = read("js/dashboard.js");
  const start = js.indexOf("async function start() {");
  assert.ok(js.indexOf("if (DEMO) {", start) < js.indexOf("finishSignInFromLink(supabase)", start), "the demo starts before any sign-in");
  assert.match(read("dashboard.html"), /Demo with sample sponsors and numbers\. Nothing here is real, and nothing you press is saved or sent\./);
});
