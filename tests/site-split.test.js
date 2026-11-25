// site-split.test.js - the donor side and the nonprofit side never mix (approved by Tanner, Nov 25, 2026).
// Each page's header must belong to its side; the only links across are the small "bridge" links.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DOCS = new URL("../docs/", import.meta.url);
const read = (page) => readFileSync(new URL(page, DOCS), "utf8");
const header = (page) => {
  const html = read(page);
  const nav = /<nav class="nav split">[\s\S]*?<\/nav>(\s*<div class="phone-menu"[\s\S]*?<\/div>)?/.exec(html);
  assert.ok(nav, `${page} has the new header`);
  return nav[0];
};

const DONOR_PAGES = ["index.html", "gifts.html", "updates.html", "certificate.html"];
const NONPROFIT_PAGES = ["nonprofits.html", "signin.html"];

test("donor pages have the donor menu, and owners only get the small bridge link", () => {
  for (const page of DONOR_PAGES) {
    const nav = header(page);
    for (const words of ["Find someone to sponsor", "How it works", "My sponsorships"]) assert.ok(nav.includes(words), `${page}: ${words}`);
    assert.match(nav, /<a class="bridge" href="nonprofits.html">For nonprofits<\/a>/, page);
    assert.doesNotMatch(nav, /signin\.html|Create your free page|Owner sign-in/, `${page}: no owner sign-in in the donor header`);
  }
  assert.match(header("index.html"), /<a class="btn btn-moss" href="gifts.html">Sign in<\/a>/, "donors sign in to My sponsorships");
});

test("nonprofit pages have the nonprofit menu and owner sign-in, never the donor menu", () => {
  for (const page of NONPROFIT_PAGES) {
    const nav = header(page);
    for (const words of ["for nonprofits", "How it works", "Pricing", "Owner sign-in", "Create your free page"]) assert.ok(nav.includes(words), `${page}: ${words}`);
    assert.doesNotMatch(nav, /gifts\.html|My sponsorships|Find someone to sponsor/, `${page}: no donor links in the nonprofit header`);
  }
  assert.match(read("nonprofits.html"), /<section id="pricing">[\s\S]*Free during <span class="accent">the pilot\.<\/span>/);
  assert.match(read("nonprofits.html"), /Looking to sponsor\? Go to covergiving\.com/, "the bridge back sits in the footer");
});

test("the two sign-ins speak to their own people", () => {
  const owner = read("signin.html");
  assert.match(owner, /<h1>Owner sign-in<\/h1>/);
  assert.match(owner, /Your nonprofit email/);
  assert.match(owner, /Sponsoring a nonprofit\? <a href="gifts.html">Sign in to My sponsorships<\/a>/);
  assert.doesNotMatch(owner, /Work email|Running a nonprofit\?/);
  const donor = readFileSync(new URL("js/gifts.js", DOCS), "utf8");
  assert.match(donor, /"Sign in to My sponsorships"/);
  assert.match(donor, /"The email you give with"/);
  assert.match(donor, /ownerLink\.href = "signin.html"/);
});

test("Privacy and Terms are neutral: a plain header and one link to each side", () => {
  for (const page of ["privacy.html", "terms.html"]) {
    const nav = header(page);
    assert.doesNotMatch(nav, /Create your free page|My sponsorships|Owner sign-in/, page);
    const footer = /<footer class="dark footer">[\s\S]*?<\/footer>/.exec(read(page))[0];
    assert.match(footer, /href="index.html">Sponsor a nonprofit/, page);
    assert.match(footer, /href="nonprofits.html">For nonprofits/, page);
  }
});

test("every page with the new header has the phone menu, and nothing else changed", () => {
  for (const page of [...DONOR_PAGES, ...NONPROFIT_PAGES, "privacy.html", "terms.html"]) {
    const html = read(page);
    if (/aria-controls="phone-menu"/.test(html)) {
      assert.match(html, /<div class="phone-menu" id="phone-menu">/, page);
      assert.match(html, /<script type="module" src="js\/menu\.js"><\/script>/, page);
    }
  }
  for (const page of ["hq.html", "dashboard.html", "sponsor.html", "give.html"]) {
    assert.doesNotMatch(read(page), /class="nav split"/, `${page} keeps its own header`);
  }
});
