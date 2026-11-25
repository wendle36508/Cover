// Tests for phase 4 (after someone signs up): the photo certificate, gift emails and who gets a gift's
// updates, the welcome email, and owner reminders before each scheduled update. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { certificateWords } from "../docs/js/certificate-logic.js";
import { CERTIFICATE_READY, frequencyNote, GIFTS_READY } from "../docs/js/checkout-logic.js";
import { validateSponsorSettings } from "../docs/js/dashboard-logic.js";
import { cleanUpdateMonths as pageMonths, pageSettings, receiveList, scheduleText } from "../docs/js/templates.js";
import { certificateView, cleanUpdateMonths, monthYear, recipientFor, remindersDue } from "../supabase/functions/_shared/after-signup.js";
import { certificateUrl, giftEmail, makeToken, readToken, reminderEmail, updateEmail, welcomeEmail } from "../supabase/functions/_shared/email.js";

const SECRET = "test-secret-that-is-long-enough-for-hmac-0123456789";
const SPONSOR = { id: "s1", first_name: "Sarah", last_initial: "K", email: "sarah@example.com", interval: "month", created_at: "2026-11-23T15:00:00Z" };
const GIFT = { ...SPONSOR, gift_name: "Mom", gift_email: "mom@example.com", gift_message: "Happy birthday!" };
const NONPROFIT = { name: "Lucky Pup Rescue", kind: "animal", page: { logo: "https://x.supabase.co/logo.png", brandColor: "#22C67A" } };
const BURT = { name: "Burt", photo_url: "https://x.supabase.co/burt.jpg", photo_focus_x: 40, photo_focus_y: 30 };

// ---------- who gets a sponsorship's emails ----------

test("a sponsor's own emails go to them", () => {
  assert.deepEqual(recipientFor(SPONSOR), { to: "sarah@example.com", firstName: "Sarah", giftFrom: null });
  assert.equal(recipientFor({}), null);
});

test("a gift's emails wait for the gift email, then go to the person it's for", () => {
  assert.equal(recipientFor(GIFT), null, "before the gift day: nobody, so the surprise isn't spoiled");
  assert.deepEqual(recipientFor({ ...GIFT, gift_sent_at: "2026-12-25T14:00:00Z" }), { to: "mom@example.com", firstName: "Mom", giftFrom: "Sarah" });
});

test("a gift's updates say who it's from and have no manage link (the giver manages billing)", () => {
  const email = updateEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Mom", itemName: "Burt", body: "Burt learned sit!",
    photoUrl: null, stopUrl: "https://covergiving.com/updates.html?a=stop&t=x", wallUrl: null, manageUrl: null, giftFrom: "Sarah" });
  assert.match(email.text, /This sponsorship is a gift from Sarah\./);
  assert.match(email.html, /a gift from Sarah/);
  assert.doesNotMatch(email.text, /Manage my gift/);
});

// ---------- the certificate ----------

test("certificate links never expire and only open the certificate", async () => {
  const token = await makeToken(SECRET, "s1", "cert", Date.parse("2026-11-23"));
  assert.deepEqual(await readToken(SECRET, token, ["cert"], Date.parse("2036-11-23")), { sponsorId: "s1", purpose: "cert" });
  assert.equal(await readToken(SECRET, token, ["stop", "pick"]), null, "a certificate link can't stop updates or move a sponsor");
  assert.match(certificateUrl(token), /^https:\/\/covergiving\.com\/certificate\.html\?t=/);
});

test("the certificate shows a name, the dog, the nonprofit and the month, and nothing private", () => {
  const view = certificateView({ sponsor: SPONSOR, nonprofit: NONPROFIT, item: BURT });
  assert.deepEqual(view, {
    holder: "Sarah K.", giftFrom: null, itemName: "Burt", photoUrl: BURT.photo_url, focus: "40% 30%", orgName: "Lucky Pup Rescue",
    kind: "animal", logo: NONPROFIT.page.logo, brandColor: "#22C67A", since: "November 2026", once: false,
  });
  assert.doesNotMatch(JSON.stringify(view), /example\.com|cents/, "no email address or amount");
  assert.equal(certificateView({ sponsor: { ...SPONSOR, business_name: "Joe's Pizza" }, nonprofit: NONPROFIT, item: BURT }).holder, "Joe's Pizza");
  assert.equal(certificateView({ sponsor: { ...SPONSOR, last_initial: null }, nonprofit: NONPROFIT, item: BURT }).holder, "Sarah");
});

test("a gift's certificate is in the recipient's name; a whole-nonprofit sponsor gets the cover photo", () => {
  const gift = certificateView({ sponsor: GIFT, nonprofit: NONPROFIT, item: BURT });
  assert.deepEqual([gift.holder, gift.giftFrom], ["Mom", "Sarah"]);
  const whole = certificateView({ sponsor: SPONSOR, nonprofit: { ...NONPROFIT, page: { coverPhoto: "https://x.supabase.co/cover.jpg" } }, item: null });
  assert.deepEqual([whole.itemName, whole.photoUrl], ["Lucky Pup Rescue", "https://x.supabase.co/cover.jpg"]);
  const unsafe = certificateView({ sponsor: SPONSOR, nonprofit: NONPROFIT, item: { ...BURT, photo_url: "javascript:alert(1)" } });
  assert.equal(unsafe.photoUrl, null, "only https photos");
});

test("the certificate's words", () => {
  assert.deepEqual(certificateWords({ holder: "Sarah K.", giftFrom: null, itemName: "Burt", orgName: "Lucky Pup Rescue", since: "November 2026", once: false }), {
    title: "Certificate of Sponsorship", intro: "This certifies that", holder: "Sarah K.", line: "sponsors Burt at Lucky Pup Rescue", date: "Since November 2026", gift: "",
  });
  const once = certificateWords({ holder: "Mom", giftFrom: "Sarah", itemName: "Burt", orgName: "Lucky Pup Rescue", since: "December 2026", once: true });
  assert.deepEqual([once.title, once.line, once.date, once.gift], ["Certificate of Thanks", "made a gift for Burt at Lucky Pup Rescue", "December 2026", "A gift from Sarah"]);
  assert.equal(certificateWords({ holder: "Sam", itemName: "Lucky Pup Rescue", orgName: "Lucky Pup Rescue", since: "" }).line, "sponsors Lucky Pup Rescue");
  assert.equal(certificateWords({ holder: "Sam", itemName: "Burt", orgName: "X", since: "" }).date, "", "no date: nothing shown");
  assert.equal(monthYear("junk"), "");
});

// ---------- welcome and gift emails ----------

test("the welcome email thanks them and links the certificate", () => {
  const monthly = welcomeEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Sarah", itemName: "Burt", interval: "month",
    certificateUrl: "https://covergiving.com/certificate.html?t=abc", manageUrl: "https://covergiving.com/gifts.html?t=m" });
  assert.equal(monthly.subject, "Welcome to Burt's team, Sarah");
  assert.match(monthly.text, /certificate\.html\?t=abc/);
  assert.match(monthly.html, /See my certificate/);
  assert.match(monthly.text, /Manage my gift/);
  const once = welcomeEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", firstName: "Sarah", itemName: "Burt", interval: "once",
    certificateUrl: "https://covergiving.com/certificate.html?t=abc", manageUrl: null });
  assert.equal(once.subject, "Thank you for your gift to Lucky Pup Rescue");
  assert.doesNotMatch(once.text, /photos and news/, "one-time givers aren't promised updates");
});

test("the gift email says who it's from, with their message", () => {
  const email = giftEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", recipientName: "Mom", giverName: "Sarah", itemName: "Burt", interval: "month",
    message: "Happy birthday! <3", certificateUrl: "https://covergiving.com/certificate.html?t=abc", stopUrl: "https://covergiving.com/updates.html?a=stop&t=s" });
  assert.equal(email.subject, "Sarah sponsored Burt for you");
  assert.match(email.text, /"Happy birthday! <3" \(Sarah\)/);
  assert.match(email.html, /Happy birthday! &lt;3/, "the message can't add HTML");
  assert.match(email.text, /Stop these updates/);
  const once = giftEmail({ nonprofitName: "Lucky Pup Rescue", kind: "animal", recipientName: "Mom", giverName: "Sarah", itemName: "Burt", interval: "once",
    message: null, certificateUrl: "https://c", stopUrl: "https://s" });
  assert.doesNotMatch(once.text, /Stop these updates/, "a one-time gift sends no updates to stop");
});

// ---------- update schedule and owner reminders ----------

test("owners pick their update months; the page says how often", () => {
  assert.deepEqual(cleanUpdateMonths([12, "2", 7, 7, 13, 0, "x"]), [2, 7, 12]);
  assert.deepEqual(pageMonths([12, 2, 7]), [2, 7, 12], "the page and server use the same rule");
  assert.equal(scheduleText([2, 7, 12]), "3 times a year");
  assert.equal(scheduleText([6]), "once a year");
  assert.equal(scheduleText([1, 7]), "twice a year");
  assert.equal(scheduleText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "every month");
  assert.equal(scheduleText([]), null);
  const settings = pageSettings({ kind: "animal", navLabel: "Dogs", updateMonths: [2, 7, 12] });
  assert.equal(receiveList(settings, "Burt")[1], "Photo updates about Burt, 3 times a year");
  assert.equal(receiveList(pageSettings({ kind: "animal" }), "Burt")[1], "Photo updates and news about Burt", "no schedule: no promise of how often");
  assert.deepEqual(validateSponsorSettings({ updateMonths: [12, 2, 99] }, []).values.updateMonths, [2, 12]);
});

test("a reminder goes out exactly a week before each picked month", () => {
  assert.deepEqual(remindersDue([12, 2, 7], "2026-11-24"), [{ dueOn: "2026-12-01", label: "December" }]);
  assert.deepEqual(remindersDue([12, 2, 7], "2026-11-23"), [], "not 8 days before");
  assert.deepEqual(remindersDue([1], "2026-12-25"), [{ dueOn: "2027-01-01", label: "January" }], "across the new year");
  assert.deepEqual(remindersDue([3], "2027-02-22"), [{ dueOn: "2027-03-01", label: "March" }], "February's short month");
  assert.deepEqual(remindersDue([5], "2026-11-24"), [], "a month they didn't pick");
  assert.deepEqual(remindersDue(undefined, "2026-11-24"), []);
  assert.deepEqual(remindersDue([12], "not a date"), []);
});

test("the reminder email tells the owner what to do", () => {
  const email = reminderEmail({ nonprofitName: "Lucky Pup Rescue", followLabel: "Dogs", dueLabel: "December", dashboardUrl: "https://covergiving.com/dashboard.html", sponsorCount: 12 });
  assert.equal(email.subject, "Time for your December update to sponsors");
  assert.match(email.text, /12 sponsors will get it/);
  assert.match(email.text, /each of your dogs/);
  assert.match(email.html, /Open my dashboard/);
});

// ---------- checkout ----------

test("checkout now offers gifts and promises the certificate", () => {
  assert.equal(CERTIFICATE_READY, true);
  assert.equal(GIFTS_READY, true);
  assert.equal(frequencyNote("once", "Burt"), "You'll get a thank-you and Burt's photo certificate.");
  assert.equal(receiveList(pageSettings({ kind: "animal" }))[0], "A photo certificate to keep or print");
});
