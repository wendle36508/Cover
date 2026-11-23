// Tests for Cover's share links (cloudflare/share): reading the link, the preview card's words and
// photo, the little page the preview apps read, and the helper itself (with a pretend database).
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { cardFor, cardHtml, destinationUrl, parseSharePath, shareUrl, singular } from "../cloudflare/share/card.js";
import worker from "../cloudflare/share/worker.js";

const LUCKY = {
  slug: "lucky-pup-rescue", name: "Lucky Pup Rescue", kind: "animal", is_live: false, price_cents: 2500, nav_label: "Dogs",
  logo: "https://x.supabase.co/storage/v1/object/public/photos/logo.png", cover_photo: "https://x.supabase.co/storage/v1/object/public/photos/cover.jpg",
  items: [
    { name: "Burt", badge: "Learning leash manners", photo_url: "https://x.supabase.co/storage/v1/object/public/photos/burt.jpg" },
    { name: "Mr. Bean", badge: null, photo_url: null },
  ],
};

test("share links are read safely", () => {
  assert.deepEqual(parseSharePath("/lucky-pup-rescue"), { org: "lucky-pup-rescue", dog: null });
  assert.deepEqual(parseSharePath("/lucky-pup-rescue/burt/"), { org: "lucky-pup-rescue", dog: "burt" });
  assert.deepEqual(parseSharePath("/Lucky-Pup-Rescue/BURT"), { org: "lucky-pup-rescue", dog: "burt" });
  for (const bad of ["/", "", "/a/b/c", "/<script>", "/lucky pup", "/lucky/../x", "/-x", `/${"a".repeat(61)}`, null]) {
    assert.equal(parseSharePath(bad), null, String(bad));
  }
});

test("share links and where they lead", () => {
  assert.equal(shareUrl("lucky-pup-rescue"), "https://go.covergiving.com/lucky-pup-rescue");
  assert.equal(shareUrl("lucky-pup-rescue", "Mr. Bean"), "https://go.covergiving.com/lucky-pup-rescue/mr-bean");
  assert.equal(destinationUrl("lucky-pup-rescue"), "https://covergiving.com/give.html?org=lucky-pup-rescue");
  assert.equal(destinationUrl("lucky-pup-rescue", "Burt"), "https://covergiving.com/give.html?org=lucky-pup-rescue&dog=burt");
  assert.equal(singular("Dogs"), "dog");
  assert.equal(singular("Programs"), "program");
  assert.equal(singular("Sponsor"), null);
  assert.equal(singular(""), null);
  assert.equal(singular("Our dogs"), null);
});

test("a dog's card: their name, tag and photo, and it opens their own page", () => {
  const card = cardFor(LUCKY, "burt");
  assert.equal(card.title, "Sponsor Burt at Lucky Pup Rescue");
  assert.equal(card.description, "Learning leash manners. Sponsor Burt for $25 a month and get photos and news. Every gift goes into one fund for everyone at Lucky Pup Rescue.");
  assert.equal(card.image, LUCKY.items[0].photo_url);
  assert.equal(card.shareUrl, "https://go.covergiving.com/lucky-pup-rescue/burt");
  assert.equal(card.destination, "https://covergiving.com/give.html?org=lucky-pup-rescue&dog=burt");
  const noPhoto = cardFor(LUCKY, "mr-bean");
  assert.equal(noPhoto.image, LUCKY.cover_photo, "no photo of their own: the cover photo");
  assert.match(noPhoto.description, /^Sponsor Mr\. Bean for \$25/, "no tag: starts with the ask");
});

test("the nonprofit's card, and an unknown dog falls back to it", () => {
  const card = cardFor(LUCKY);
  assert.equal(card.title, "Sponsor a dog at Lucky Pup Rescue");
  assert.match(card.description, /^Monthly sponsorship for \$25 a month\. Pick a dog to follow/);
  assert.equal(card.image, LUCKY.cover_photo);
  assert.deepEqual(cardFor(LUCKY, "nobody"), card);
  const plain = cardFor({ slug: "pantry", name: "Pantry", nav_label: null, price_cents: 0, items: [{ name: "Meals", photo_url: "https://x/m.jpg" }] });
  assert.equal(plain.title, "Sponsor Pantry");
  assert.equal(plain.image, "https://x/m.jpg", "no cover photo: the first photo");
  assert.equal(cardFor({ slug: "empty", name: "Empty", items: [] }).image, "https://covergiving.com/photos/dog-smile.jpg", "nothing at all: Cover's own photo");
  assert.equal(cardFor({ ...LUCKY, cover_photo: "javascript:alert(1)" }).image, LUCKY.items[0].photo_url, "unsafe photo links are skipped");
});

test("the preview page has the card tags, sends people on, and can't be broken by a name", () => {
  const html = cardHtml(cardFor(LUCKY, "burt"), "Lucky Pup Rescue");
  for (const tag of ['property="og:title" content="Sponsor Burt at Lucky Pup Rescue"', 'property="og:image"', 'property="og:url" content="https://go.covergiving.com/lucky-pup-rescue/burt"', 'name="twitter:card" content="summary_large_image"']) {
    assert.ok(html.includes(tag), tag);
  }
  assert.match(html, /location\.replace\("https:\/\/covergiving\.com\/give\.html\?org=lucky-pup-rescue&dog=burt"\)/);
  assert.doesNotMatch(html, /http-equiv="refresh"/, "no automatic redirect tag (some preview apps follow it)");
  const nasty = cardHtml(cardFor({ ...LUCKY, name: 'Paws "&" <Co>', items: [{ name: "</script><b>", photo_url: null }] }, "script-b"));
  assert.doesNotMatch(nasty, /<b>/);
  assert.doesNotMatch(nasty, /<\/script><b>/);
  assert.match(nasty, /Paws &quot;&amp;&quot; &lt;Co&gt;/);
});

// ---------- the Cloudflare helper, with a pretend database ----------

const ENV = { SUPABASE_URL: "https://db.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));
const answer = (body, status = 200) => (globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

test("helper: a dog's link answers with its card page", async () => {
  let asked;
  globalThis.fetch = (url, init) => {
    asked = { url, body: JSON.parse(init.body) };
    return Promise.resolve(new Response(JSON.stringify(LUCKY)));
  };
  const response = await worker.fetch(new Request("https://go.covergiving.com/lucky-pup-rescue/burt"), ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await response.text(), /Sponsor Burt at Lucky Pup Rescue/);
  assert.deepEqual(asked, { url: "https://db.example/rest/v1/rpc/share_card", body: { org_slug: "lucky-pup-rescue" } });
});

test("helper: unknown nonprofits, bad links and outages never dead-end", async () => {
  answer(null);
  let response = await worker.fetch(new Request("https://go.covergiving.com/nobody"), ENV);
  assert.deepEqual([response.status, response.headers.get("location")], [302, "https://covergiving.com/"]);
  response = await worker.fetch(new Request("https://go.covergiving.com/"), ENV);
  assert.deepEqual([response.status, response.headers.get("location")], [302, "https://covergiving.com/"]);
  answer({ message: "down" }, 503);
  response = await worker.fetch(new Request("https://go.covergiving.com/lucky-pup-rescue/burt"), ENV);
  assert.deepEqual([response.status, response.headers.get("location")], [302, "https://covergiving.com/give.html?org=lucky-pup-rescue"]);
  globalThis.fetch = () => Promise.reject(new Error("network"));
  response = await worker.fetch(new Request("https://go.covergiving.com/lucky-pup-rescue"), ENV);
  assert.equal(response.status, 302);
  response = await worker.fetch(new Request("https://go.covergiving.com/lucky-pup-rescue", { method: "POST" }), ENV);
  assert.equal(response.status, 405);
});

test("the dashboard's share links match the Cloudflare helper's, and the sign and QR names are tidy", async () => {
  const { qrFileName, shareLink, signLink } = await import("../docs/js/share.js");
  for (const name of [null, "Burt", "Mr. Bean", "Zoë", "Salt & Pepper"]) {
    assert.equal(shareLink("lucky-pup-rescue", name), shareUrl("lucky-pup-rescue", name), String(name));
  }
  assert.equal(signLink("lucky-pup-rescue"), "sign.html?org=lucky-pup-rescue");
  assert.equal(signLink("lucky-pup-rescue", "Mr. Bean"), "sign.html?org=lucky-pup-rescue&dog=mr-bean");
  assert.equal(qrFileName("lucky-pup-rescue"), "lucky-pup-rescue-qr.png");
  assert.equal(qrFileName("lucky-pup-rescue", "Burt"), "lucky-pup-rescue-burt-qr.png");
});
