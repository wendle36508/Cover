// their-look.test.js - a nonprofit's sponsor page in their own look, inside Cover's layout
// (Tanner, Nov 25, 2026): their color, their headline and intro, their dogs on the home page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contrast, orgTheme } from "../docs/js/brand.js";
import { heroWords, shortIntro } from "../docs/js/sponsor-page-logic.js";
import { orgFromRows } from "../docs/js/live.js";

const CREAM = "#F4EFE6";

test("their color becomes the page's colors, always readable", () => {
  for (const color of ["#0898D0", "#22C67A", "#FFEE00", "#14181C", "#D6406B", "#7B4FC9", "#ffffff"]) {
    const t = orgTheme(color);
    assert.ok(contrast(t["--moss"], CREAM) >= 4.5, `${color}: buttons and links read on cream`);
    assert.ok(contrast(CREAM, t["--deep"]) >= 7, `${color}: cream text reads on the dark sections`);
    assert.ok(contrast(t["--light-sage"], t["--deep"]) >= 4.5, `${color}: accent words read on the dark sections`);
  }
  const lucky = orgTheme("#0898D0");
  assert.equal(lucky["--moss"], "#086F99", "Lucky Pup's blue, a little darker so it reads");
  assert.equal(orgTheme("not a color"), null, "a bad color keeps Cover's moss and cream");
  assert.equal(orgTheme(null), null);
});

test("their own headline leads the page, with the last words as the accent", () => {
  assert.deepEqual(heroWords("Not every pup is lucky enough to have a forever home. That's where we come in."), {
    main: "Not every pup is lucky enough to have", accent: "a forever home.", rest: "That's where we come in.",
  });
  assert.deepEqual(heroWords("Meals for every neighbor"), { main: "Meals for", accent: "every neighbor", rest: "" });
  assert.deepEqual(heroWords("Hi there"), { main: "Hi there", accent: "", rest: "" }, "too short for an accent");
  assert.equal(heroWords(""), null);
  assert.equal(heroWords(null), null);
});

test("the intro is shortened to whole sentences", () => {
  const lead = "Lucky Pup Rescue is a volunteer-run, foster-based dog rescue in southern Maine. Since 2008 we've found forever homes for more than 2,000 dogs. Monthly sponsors keep our foster dogs fed, trained and cared for until they find their families.";
  const short = shortIntro(lead, 160);
  assert.equal(short, "Lucky Pup Rescue is a volunteer-run, foster-based dog rescue in southern Maine. Since 2008 we've found forever homes for more than 2,000 dogs.");
  assert.equal(shortIntro("Short."), "Short.");
  assert.equal(shortIntro(""), "");
});

test("the page knows which words the nonprofit wrote themselves", () => {
  const nonprofit = { id: "n1", slug: "lucky", name: "Lucky Pup Rescue", kind: "animal", monthly_price_cents: 2500, monthly_goal_cents: 200000 };
  const mine = orgFromRows({ ...nonprofit, page: { headline: "  Not every pup is lucky.  ", lead: "We rescue dogs." } }, [], [], 0, [], []);
  assert.equal(mine.ownHeadline, "Not every pup is lucky.");
  assert.equal(mine.ownLead, "We rescue dogs.");
  const blank = orgFromRows({ ...nonprofit, page: {} }, [], [], 0, [], []);
  assert.equal(blank.ownHeadline, null, "no headline of their own: the page says 'Sponsor a dog.'");
  assert.equal(blank.ownLead, null);
});

test("the sponsor page uses their theme, tints Cover's drawings and shows their dogs", () => {
  const page = readFileSync(new URL("../docs/js/sponsor-page.js", import.meta.url), "utf8");
  assert.match(page, /applyTheme\(document\.body, org\.brandColor\)/);
  assert.match(page, /tinted\("ic", drawingFor\(help\.icon\)\)/);
  assert.match(page, /"Meet the ones", "", "waiting for you\."/);
  const css = readFileSync(new URL("../docs/css/sponsor.css", import.meta.url), "utf8");
  assert.match(css, /\.sp-ticks li::before \{[^}]*background: var\(--moss\);[^}]*mask:/, "check marks in their color");
  const html = readFileSync(new URL("../docs/sponsor.html", import.meta.url), "utf8");
  assert.match(html, /css\/sponsor\.css\?v=/, "returning visitors get the new styles");
  assert.match(html, /js\/sponsor-page\.js\?v=/);
});
