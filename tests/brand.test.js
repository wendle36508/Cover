// Tests for docs/js/brand.js (a nonprofit's own colors, links and logo). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRAND_SWATCHES, brandColors, contrast, normalizeHex, pageLinks, safeImageUrl, socialLink, validateLook, websiteLink,
} from "../docs/js/brand.js";

test("color codes are cleaned up or rejected", () => {
  assert.equal(normalizeHex("#e8743b"), "#E8743B");
  assert.equal(normalizeHex("E8743B"), "#E8743B");
  assert.equal(normalizeHex("#e73"), "#EE7733");
  for (const bad of ["", "red", "#12345", "#GGGGGG", "url(x)", null, "#E8743B; background:red"]) assert.equal(normalizeHex(bad), null, bad);
});

test("every brand color gives readable text and button labels", () => {
  for (const color of [...BRAND_SWATCHES, "#FFFF00", "#FFFFFF", "#000000", "#A0E0FF", "#777777"]) {
    const colors = brandColors(color);
    assert.ok(contrast(colors["--green-dark"], "#FFFFFF") >= 4.5, `dark text for ${color}`);
    // Button label: whichever of dark or white reads better. Mid-tones (pink, gray) can't reach
    // 4.5 with either, so the floor for these short bold labels is 3.
    const best = Math.max(contrast(color, "#14181C"), contrast(color, "#FFFFFF"));
    assert.equal(contrast(color, colors["--on-green"]), best, `best button text for ${color}`);
    assert.ok(best >= 3, `button text for ${color}`);
  }
  assert.equal(brandColors("#14181C")["--on-green"], "#FFFFFF");
  assert.equal(brandColors("#FFFF00")["--on-green"], "#14181C");
  assert.equal(brandColors("nope"), null);
});

test("websites become safe https links", () => {
  assert.deepEqual(websiteLink("harborpaws.org"), { href: "https://harborpaws.org/", label: "harborpaws.org" });
  assert.equal(websiteLink("http://www.harborpaws.org/about").href, "https://www.harborpaws.org/about");
  assert.equal(websiteLink("www.harborpaws.org").label, "harborpaws.org");
  for (const bad of ["", "javascript:alert(1)", "not a site", "https://user:pw@evil.com", "localhost"]) assert.equal(websiteLink(bad), null, bad);
});

test("Instagram and Facebook accept handles or links, nothing else", () => {
  assert.equal(socialLink("instagram", "@harborpaws").href, "https://instagram.com/harborpaws");
  assert.equal(socialLink("instagram", "https://www.instagram.com/harbor.paws/?hl=en").href, "https://instagram.com/harbor.paws");
  assert.equal(socialLink("facebook", "facebook.com/harborpaws").href, "https://facebook.com/harborpaws");
  assert.equal(socialLink("facebook", "https://m.facebook.com/HarborPaws").href, "https://facebook.com/HarborPaws");
  assert.equal(socialLink("instagram", "javascript:alert(1)"), null);
  assert.equal(socialLink("instagram", "<script>"), null);
  assert.equal(socialLink("tiktok", "@x"), null);
  assert.equal(socialLink("instagram", ""), null);
});

test("page links skip anything unsafe", () => {
  const links = pageLinks({ website: "harborpaws.org", instagram: "@harborpaws", facebook: "javascript:alert(1)" });
  assert.deepEqual(links.map((l) => l.label), ["harborpaws.org", "Instagram"]);
  assert.deepEqual(pageLinks(undefined), []);
});

test("the Look and feel form", () => {
  const good = validateLook({ brandColor: "e8743b", thanks: "  Thank   you!  ", website: "harborpaws.org", instagram: "@hp", facebook: "" });
  assert.equal(good.ok, true);
  assert.equal(good.values.brandColor, "#E8743B");
  assert.equal(good.values.thanks, "Thank you!");
  const bad = validateLook({ brandColor: "purple", thanks: "x".repeat(301), website: "nope", instagram: "a b", facebook: "<x>" });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["brandColor", "facebook", "instagram", "thanks", "website"]);
  assert.equal(validateLook({}).ok, true);
});

test("only https photo addresses are shown", () => {
  assert.equal(safeImageUrl("https://x.supabase.co/storage/v1/object/public/photos/a.png"), "https://x.supabase.co/storage/v1/object/public/photos/a.png");
  for (const bad of ["", "http://x.com/a.png", "javascript:alert(1)", 'https://x.com/a.png" onerror="x', null]) assert.equal(safeImageUrl(bad), "", bad);
});

test("live pages carry the nonprofit's cover photo and look settings", async () => {
  const { orgFromRows } = await import("../docs/js/live.js");
  const nonprofit = { id: "n1", slug: "hp", name: "Harbor Paws", kind: "animal", monthly_price_cents: 2500, monthly_goal_cents: 200000,
    page: { coverPhoto: "https://x.supabase.co/a.jpg", brandColor: "#E8743B", thanks: "Thank you!", logo: "https://x.supabase.co/l.png" } };
  const org = orgFromRows(nonprofit, []);
  assert.equal(org.heroPhotoWide, "https://x.supabase.co/a.jpg");
  assert.equal(org.brandColor, "#E8743B");
  assert.equal(org.thanks, "Thank you!");
  assert.equal(orgFromRows({ ...nonprofit, page: { coverPhoto: "javascript:x" } }, []).heroPhotoWide, undefined);
});
