// Tests for supabase/functions/_shared/email.js (secure email links and the adoption note). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptionEmail, escapeHtml, fromLine, linkUrl, makeToken, readToken } from "../supabase/functions/_shared/email.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const SPONSOR = "6d86c4fb-be6b-4179-87b3-c86709f142f8";
const DAY = 86400 * 1000;

test("a genuine link is read back, for its purpose only", async () => {
  const stop = await makeToken(SECRET, SPONSOR, "stop");
  assert.deepEqual(await readToken(SECRET, stop, ["stop"]), { sponsorId: SPONSOR, purpose: "stop" });
  assert.equal(await readToken(SECRET, stop, ["pick"]), null, "a stop link can't be used to move a follow");
});

test("fake, edited or wrongly signed links are refused", async () => {
  const token = await makeToken(SECRET, SPONSOR, "pick");
  const [body, sig] = token.split(".");
  const otherBody = Buffer.from(JSON.stringify({ s: "someone-else", p: "pick", x: 0 })).toString("base64url");
  for (const bad of ["", "abc", `${body}.`, `.${sig}`, `${otherBody}.${sig}`, `${body}.${sig.slice(0, -2)}xx`, `${body}.${sig}.extra`]) {
    assert.equal(await readToken(SECRET, bad, ["pick", "stop"]), null, bad);
  }
  assert.equal(await readToken("a-different-secret-that-is-also-long-123", token, ["pick"]), null);
});

test("pick links expire after 30 days, stop links never do", async () => {
  const now = Date.UTC(2026, 10, 14);
  const pick = await makeToken(SECRET, SPONSOR, "pick", now);
  assert.ok(await readToken(SECRET, pick, ["pick"], now + 29 * DAY));
  assert.equal(await readToken(SECRET, pick, ["pick"], now + 31 * DAY), null);
  const stop = await makeToken(SECRET, SPONSOR, "stop", now);
  assert.ok(await readToken(SECRET, stop, ["stop"], now + 3650 * DAY));
});

test("a missing or short secret is a clear error, not a weak link", async () => {
  await assert.rejects(makeToken("", SPONSOR, "stop"), /secret/);
  await assert.rejects(makeToken("short", SPONSOR, "stop"), /secret/);
  await assert.rejects(makeToken(SECRET, SPONSOR, "delete"), /purpose/);
});

test("links point at covergiving.com", () => {
  assert.equal(linkUrl("stop", "a.b"), "https://covergiving.com/updates.html?a=stop&t=a.b");
});

test("the From line can't be broken by an odd nonprofit name", () => {
  assert.equal(fromLine("Harbor Paws Rescue"), "Harbor Paws Rescue via Cover <hello@covergiving.com>");
  assert.equal(fromLine('Evil"\r\nBcc: x@y.com <a>'), "Evil Bcc: x@y.com a via Cover <hello@covergiving.com>");
  assert.equal(fromLine(""), "Cover via Cover <hello@covergiving.com>");
});

const base = {
  nonprofitName: "Harbor Paws", kind: "animal", firstName: "Sarah", finishedName: "Bella",
  ownerNote: "Went home with the Lee family!", pickUrl: "https://covergiving.com/updates.html?a=pick&t=p", stopUrl: "https://covergiving.com/updates.html?a=stop&t=s",
};

test("adoption note: the usual case", () => {
  const email = adoptionEmail(base);
  assert.equal(email.subject, "Bella went home!");
  for (const part of ["Hi Sarah,", "Bella was adopted", "Went home with the Lee family!", "keeps helping every animal", "Would you like to follow a new buddy?", "Pick a new buddy", "reply to this email", "Stop these updates"]) {
    assert.ok(email.text.includes(part) || email.html.includes(part), part);
  }
  // In HTML the "&" inside a link is written "&amp;" (browsers and email apps turn it back).
  assert.ok(email.html.includes(escapeHtml(base.stopUrl)) && email.html.includes(escapeHtml(base.pickUrl)));
  assert.ok(!/\n\n\n/.test(email.text), "no big blank gaps in the plain-text version");
});

test("adoption note never says they were moved, and handles nobody else on the page and programs", () => {
  assert.ok(!/now following/i.test(adoptionEmail(base).text), "sponsors are asked, never moved automatically");
  const alone = adoptionEmail({ ...base, pickUrl: null, ownerNote: "" });
  assert.match(alone.text, /news from the whole rescue/);
  assert.ok(!alone.html.includes("Pick a new buddy"));
  const program = adoptionEmail({ ...base, kind: "program", finishedName: "Family Night" });
  assert.equal(program.subject, "Family Night has wrapped up");
  assert.match(program.text, /helping everything at Harbor Paws/);
  assert.match(program.html, /Pick what to follow/);
});

test("anything a nonprofit or sponsor typed can't inject HTML into the email", () => {
  const email = adoptionEmail({ ...base, firstName: "<script>x</script>", ownerNote: '"><img src=x onerror=alert(1)>' });
  assert.ok(!email.html.includes("<script>") && !email.html.includes("<img"));
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("owner update email: photo, the line, and the stop link", async () => {
  const { updateEmail } = await import("../supabase/functions/_shared/email.js");
  const details = { nonprofitName: "Harbor Paws", kind: "animal", firstName: "Sarah", itemName: "Bella", body: "Bella learned to sit today!",
    photoUrl: "https://x.supabase.co/storage/v1/object/public/photos/a.jpg", stopUrl: "https://covergiving.com/updates.html?a=stop&t=s" };
  const email = updateEmail(details);
  assert.equal(email.subject, "News about Bella");
  for (const part of ["Hi Sarah,", "Bella learned to sit today!", "every animal at Harbor Paws", "reply to this email", "Stop updates about Bella"]) {
    assert.ok(email.text.includes(part) && email.html.includes(part), part);
  }
  assert.ok(email.html.includes('<img src="https://x.supabase.co/storage/v1/object/public/photos/a.jpg"'));
  assert.ok(!updateEmail({ ...details, photoUrl: "" }).html.includes("<img"));
  assert.ok(!updateEmail({ ...details, photoUrl: 'javascript:alert(1)' }).html.includes("<img"));
  const sneaky = updateEmail({ ...details, body: "<b>hi</b>", itemName: '"><script>' });
  assert.ok(!sneaky.html.includes("<script>") && !sneaky.html.includes("<b>hi"));
  assert.match(updateEmail({ ...details, kind: "program" }).text, /helps everything at Harbor Paws/);
});
