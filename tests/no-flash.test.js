// no-flash.test.js - visitors on their way to a new sponsor page never see the old page flash by
// (bug found by Tanner, Nov 25, 2026). Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8");

test("the old sponsor page starts hidden, and always shows again within 3 seconds", () => {
  const html = read("give.html");
  const wait = html.indexOf('<style id="cover-wait">');
  assert.ok(wait > 0 && wait < html.indexOf('href="css/cover.css"'), "hidden before its old styles load");
  assert.match(html, /body \{ visibility: hidden; \}/);
  assert.match(html, /setTimeout\(function \(\) \{ var s = document\.getElementById\("cover-wait"\); if \(s\) s\.remove\(\); \}, 3000\);/);
});

test("it checks where to go first, with one small request, before showing anything", () => {
  const js = read("js/give.js");
  const check = js.indexOf("forward = await usesNewPage(requestedSlug)");
  assert.ok(check > 0, "asks whether the nonprofit uses the new page");
  assert.ok(check < js.indexOf("reveal();"), "forwards before the page is shown");
  assert.ok(js.indexOf("reveal();") < js.indexOf("live = await loadLiveOrg(requestedSlug)"), "nonprofits on the old page see it as before");
  assert.match(read("js/live.js"), /export async function usesNewPage\(slug\) \{[\s\S]*select=new_page/);
});

test("the small forwarding pages are blank cream, never a white flash", () => {
  for (const page of ["nonprofits", "give", "gifts", "signin", "sponsor", "privacy", "terms"]) {
    assert.match(read(`${page}/index.html`), /html \{ background: #F4EFE6; \} body \{ visibility: hidden; \}/, page);
  }
});

test("the dashboard's View page link goes straight to the page the nonprofit uses", () => {
  assert.match(read("js/dashboard.js"), /pageUrl\(state\.nonprofit\.new_page \? "sponsor\.html" : "give\.html"\)/);
});
