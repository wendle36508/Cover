// Tests for each dog's own page on the sponsor page (Nov 22): the dog's link, finding a dog from a
// link, the longer story, and the extra photos coming from the database. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { orgFromRows } from "../docs/js/live.js";
import { findItemBySlug, itemSlug, midSentence, storyParagraphs } from "../docs/js/sponsor.js";

test("each dog's link part is its name, tidied", () => {
  assert.equal(itemSlug("Burt"), "burt");
  assert.equal(itemSlug("Mr. Bean"), "mr-bean");
  assert.equal(itemSlug("  Zoë  "), "zoe");
  assert.equal(itemSlug("Salt & Pepper"), "salt-and-pepper");
  assert.equal(itemSlug("After-School Tutoring"), "after-school-tutoring");
  assert.equal(itemSlug(null), "");
});

test("a dog's link finds that dog, ignoring case; a bad or missing link finds nobody", () => {
  const items = [{ name: "Burt" }, { name: "Mr. Bean" }];
  assert.equal(findItemBySlug(items, "burt"), items[0]);
  assert.equal(findItemBySlug(items, "BURT"), items[0]);
  assert.equal(findItemBySlug(items, "mr-bean"), items[1]);
  assert.equal(findItemBySlug(items, "gemma"), null);
  assert.equal(findItemBySlug(items, ""), null);
  assert.equal(findItemBySlug(items, null), null);
  assert.equal(findItemBySlug(undefined, "burt"), null);
  assert.equal(findItemBySlug(items, "<script>"), null);
});

test("a longer story splits into paragraphs at blank lines", () => {
  assert.deepEqual(storyParagraphs("Burt came to us in June.\n\nHe loves   the park.\nAnd naps."), ["Burt came to us in June.", "He loves the park. And naps."]);
  assert.deepEqual(storyParagraphs(""), []);
  assert.deepEqual(storyParagraphs(null), []);
  assert.deepEqual(storyParagraphs("\n\n  \n\n"), []);
});

test("the 'who the gift helps' phrase reads mid-sentence", () => {
  assert.equal(midSentence("Dogs in our foster homes across New England"), "dogs in our foster homes across New England");
  assert.equal(midSentence("every dog here"), "every dog here");
  assert.equal(midSentence("BBQ fund kids"), "BBQ fund kids");
  assert.equal(midSentence(undefined), "");
});

test("the story and extra photos come through from the database; unsafe photo links are dropped", () => {
  const nonprofit = { id: "np", slug: "lucky", name: "Lucky Pup Rescue", kind: "animal", monthly_price_cents: 2500, monthly_goal_cents: 200000, page: {} };
  const items = [
    { id: "a", name: "Burt", photo_url: "https://x/burt.jpg", story: "Long story.", more_photos: ["https://x/1.jpg", "javascript:alert(1)", "http://x/2.jpg", "https://x/3.jpg"] },
    { id: "b", name: "Fiona", photo_url: null },
  ];
  const [burt, fiona] = orgFromRows(nonprofit, items).items;
  assert.equal(burt.story, "Long story.");
  assert.deepEqual(burt.morePhotos, ["https://x/1.jpg", "https://x/3.jpg"]);
  assert.equal(fiona.story, "");
  assert.deepEqual(fiona.morePhotos, []);
  const many = orgFromRows(nonprofit, [{ ...items[0], more_photos: Array.from({ length: 9 }, (_, i) => `https://x/${i}.jpg`) }]).items[0];
  assert.equal(many.morePhotos.length, 6, "never more than 6");
});

test("dashboard: the longer story keeps paragraphs, tidies spaces, and has a limit", async () => {
  const { cleanStory, validateItem, STORY_MAX } = await import("../docs/js/dashboard-logic.js");
  assert.equal(cleanStory("  First   line.\r\nSame paragraph.\r\n\r\n\r\n\r\nSecond  paragraph.  "), "First line.\nSame paragraph.\n\nSecond paragraph.");
  assert.equal(cleanStory(undefined), "");
  assert.equal(validateItem({ name: "Burt", story: "A".repeat(STORY_MAX) }).ok, true);
  assert.match(validateItem({ name: "Burt", story: "A".repeat(STORY_MAX + 1) }).errors.story, /1,200/);
  assert.equal(validateItem({ name: "Burt" }).values.story, "", "the story is optional");
});
