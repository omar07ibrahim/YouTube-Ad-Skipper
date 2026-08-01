"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  STATE_KEY,
  bootstrap,
  formatDisplayCount,
  hasUnsupportedCounterSchema,
  isCounterState,
  normalizeCount,
  readCounterValue,
  renderCount,
  renderError,
} = require("../popup.js");

const root = path.resolve(__dirname, "..");

function createElement() {
  const attributes = new Map();
  return {
    attributes,
    textContent: "",
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];

function counterState(count, recentActionIds = IDS) {
  return { schemaVersion: 1, count, recentActionIds };
}

function createChrome(storedValue, legacyValue = 0) {
  const listeners = [];
  return {
    storage: {
      local: {
        async get() {
          return { [STATE_KEY]: storedValue, adsSkipped: legacyValue };
        },
      },
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
    test: { listeners },
  };
}

test("popup count formatting is bounded and has an explicit error state", () => {
  const element = createElement();
  assert.equal(normalizeCount(14), 14);
  assert.equal(normalizeCount(-1), 0);
  assert.equal(normalizeCount("14"), 0);
  assert.equal(formatDisplayCount(999), "999");
  assert.equal(formatDisplayCount(1_000), "999+");
  assert.equal(formatDisplayCount(Number.MAX_SAFE_INTEGER), "999+");

  renderCount(element, Number.MAX_SAFE_INTEGER);
  assert.equal(element.textContent, "999+");
  assert.equal(
    element.attributes.get("aria-label"),
    `${Number.MAX_SAFE_INTEGER} skip actions recorded`,
  );
  assert.equal(element.attributes.has("data-state"), false);

  renderError(element);
  assert.equal(element.textContent, "—");
  assert.equal(element.attributes.get("data-state"), "error");
  assert.equal(
    element.attributes.get("aria-label"),
    "Skip action count unavailable",
  );
});

test("popup accepts only the bounded durable counter schema", () => {
  assert.equal(isCounterState(counterState(14)), true);
  assert.equal(readCounterValue({ [STATE_KEY]: counterState(14) }), 14);
  assert.equal(readCounterValue({ adsSkipped: 9 }), 9);

  for (const invalid of [
    null,
    { schemaVersion: 2, count: 14, recentActionIds: IDS },
    { schemaVersion: 1, count: -1, recentActionIds: IDS },
    { schemaVersion: 1, count: 14, recentActionIds: [IDS[0], IDS[0]] },
    { schemaVersion: 1, count: 14, recentActionIds: ["raw-target-id"] },
    { schemaVersion: 1, count: 14, recentActionIds: IDS, extra: true },
    {
      schemaVersion: 1,
      count: 14,
      recentActionIds: Array.from(
        { length: 257 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    },
  ]) {
    assert.equal(isCounterState(invalid), false);
  }
  assert.equal(hasUnsupportedCounterSchema(counterState(14)), false);
  assert.equal(
    hasUnsupportedCounterSchema({
      schemaVersion: 2,
      count: 14,
      recentActionIds: [],
    }),
    true,
  );
  assert.throws(
    () =>
      readCounterValue({
        [STATE_KEY]: {
          schemaVersion: 2,
          count: 14,
          recentActionIds: [],
        },
        adsSkipped: 9,
      }),
    /unsupported counter state schema/,
  );
});

test("popup loads the durable count and follows local storage changes", async () => {
  const element = createElement();
  const chromeApi = createChrome(counterState(7), 3);
  await bootstrap(
    { getElementById: () => element },
    chromeApi,
  );

  assert.equal(element.textContent, "7");
  assert.equal(chromeApi.test.listeners.length, 1);
  chromeApi.test.listeners[0](
    {
      [STATE_KEY]: {
        oldValue: counterState(7),
        newValue: counterState(8),
      },
    },
    "local",
  );
  assert.equal(element.textContent, "8");
  chromeApi.test.listeners[0](
    { adsSkipped: { oldValue: 3, newValue: undefined } },
    "local",
  );
  assert.equal(element.textContent, "8");
  chromeApi.test.listeners[0](
    {
      [STATE_KEY]: {
        oldValue: counterState(8),
        newValue: counterState(9),
      },
    },
    "sync",
  );
  assert.equal(element.textContent, "8");
});

test("a storage change that races the initial read cannot be overwritten", async () => {
  const element = createElement();
  let resolveRead;
  const chromeApi = createChrome(counterState(7));
  chromeApi.storage.local.get = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });

  const loading = bootstrap(
    { getElementById: () => element },
    chromeApi,
  );
  chromeApi.test.listeners[0](
    {
      [STATE_KEY]: {
        oldValue: counterState(7),
        newValue: counterState(8),
      },
    },
    "local",
  );
  resolveRead({ [STATE_KEY]: counterState(7), adsSkipped: 0 });
  await loading;

  assert.equal(element.textContent, "8");
});

test("a migrated durable state wins over a racing legacy update", async () => {
  const element = createElement();
  let resolveRead;
  const chromeApi = createChrome(counterState(11), 7);
  chromeApi.storage.local.get = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });

  const loading = bootstrap(
    { getElementById: () => element },
    chromeApi,
  );
  chromeApi.test.listeners[0](
    { adsSkipped: { oldValue: 7, newValue: 8 } },
    "local",
  );
  assert.equal(element.textContent, "8");
  resolveRead({ [STATE_KEY]: counterState(11), adsSkipped: 7 });
  await loading;

  assert.equal(element.textContent, "11");
});

test("a rejected storage read exposes an accessible unavailable state", async () => {
  const element = createElement();
  const chromeApi = createChrome(counterState(0));
  chromeApi.storage.local.get = async () => {
    throw new Error("storage unavailable");
  };

  await bootstrap(
    { getElementById: () => element },
    chromeApi,
  );

  assert.equal(element.textContent, "—");
  assert.equal(element.attributes.get("data-state"), "error");
  assert.equal(
    element.attributes.get("aria-label"),
    "Skip action count unavailable",
  );
});

test("popup contains no remote image, inline style, or personal support widget", () => {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "popup.css"), "utf8");
  const forbidden = [
    /<style\b/i,
    /src=["']https?:/i,
    /<link\b[^>]*href=["']https?:/i,
    /\sstyle=/i,
    /\son[a-z]+=/i,
    /t\.me/i,
    /telegram/i,
    /buymeacoffee/i,
    /kofe\.al/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(html, pattern);
  }
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /url\(\s*["']?https?:/i);
  assert.match(html, /href="popup\.css"/);
  assert.match(html, />Skip actions</);
  assert.match(html, /committed to durable local counter storage/i);
});

test("README removes token-like links and makes bounded claims", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  for (const pattern of [
    /token=/i,
    /ltdfoto/i,
    /t\.me/i,
    /buymeacoffee/i,
    /kofe\.al/i,
    /guardian against/i,
    /uninterrupted/i,
  ]) {
    assert.doesNotMatch(readme, pattern);
  }
  assert.match(readme, /does not block ad requests/i);
  assert.match(readme, /not\s+proof that YouTube completed a skip/i);
  assert.match(readme, /bounded idempotency, not a transaction/i);
  assert.match(readme, /newer clicks are omitted\s+from the best-effort tally/i);
  assert.match(readme, /at most 256 random action IDs/i);
  assert.match(readme, /both values can briefly\s+coexist/i);
  assert.match(readme, /docs\/assets\/offline-workflow\.gif/);
  assert.match(readme, /not live\s+YouTube-ad acceptance/i);
});
