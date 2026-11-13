// Tests for docs/js/store.js, using a fake browser storage. Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { clearSponsors, loadSponsors, saveSponsor, sponsorsFor } from "../docs/js/store.js";

function fakeStorage(start = {}) {
  const data = { ...start };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

const record = (orgKey, itemName) => ({ id: `${orgKey}-${itemName}`, orgKey, itemName });

test("empty storage gives an empty list", () => {
  assert.deepEqual(loadSponsors(fakeStorage()), []);
});

test("saved sponsors come back in order, filtered by nonprofit", () => {
  const storage = fakeStorage();
  assert.equal(saveSponsor(record("rescue", "Bella"), storage), true);
  saveSponsor(record("pantry", "Kitchen"), storage);
  saveSponsor(record("rescue", "Moose"), storage);
  assert.deepEqual(loadSponsors(storage).map((r) => r.itemName), ["Bella", "Kitchen", "Moose"]);
  assert.deepEqual(sponsorsFor("rescue", storage).map((r) => r.itemName), ["Bella", "Moose"]);
});

test("broken or wrong-shaped data is ignored, not a crash", () => {
  assert.deepEqual(loadSponsors(fakeStorage({ "cover.sponsors.v1": "{not json" })), []);
  assert.deepEqual(loadSponsors(fakeStorage({ "cover.sponsors.v1": '{"a":1}' })), []);
});

test("no storage at all (private window) fails quietly", () => {
  assert.deepEqual(loadSponsors(null), []);
  assert.equal(saveSponsor(record("rescue", "Bella"), null), false);
  clearSponsors(null);
});

test("a full or blocked storage reports the save failed", () => {
  const storage = { ...fakeStorage(), setItem: () => { throw new Error("full"); } };
  assert.equal(saveSponsor(record("rescue", "Bella"), storage), false);
});

test("clear removes everything", () => {
  const storage = fakeStorage();
  saveSponsor(record("rescue", "Bella"), storage);
  clearSponsors(storage);
  assert.deepEqual(loadSponsors(storage), []);
});
