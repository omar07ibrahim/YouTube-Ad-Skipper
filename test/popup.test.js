"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  bootstrap,
  formatDisplayCount,
  normalizeCount,
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

function createChrome(storedValue) {
  const listeners = [];
  return {
    storage: {
      local: {
        async get() {
          return { adsSkipped: storedValue };
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

test("popup loads the durable count and follows local storage changes", async () => {
  const element = createElement();
  const chromeApi = createChrome(7);
  await bootstrap(
    { getElementById: () => element },
    chromeApi,
  );

  assert.equal(element.textContent, "7");
  assert.equal(chromeApi.test.listeners.length, 1);
  chromeApi.test.listeners[0](
    { adsSkipped: { oldValue: 7, newValue: 8 } },
    "local",
  );
  assert.equal(element.textContent, "8");
  chromeApi.test.listeners[0](
    { adsSkipped: { oldValue: 8, newValue: 9 } },
    "sync",
  );
  assert.equal(element.textContent, "8");
});

test("a storage change that races the initial read cannot be overwritten", async () => {
  const element = createElement();
  let resolveRead;
  const chromeApi = createChrome(7);
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
  resolveRead({ adsSkipped: 7 });
  await loading;

  assert.equal(element.textContent, "8");
});

test("a rejected storage read exposes an accessible unavailable state", async () => {
  const element = createElement();
  const chromeApi = createChrome(0);
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
  assert.match(readme, /not proof that YouTube completed a skip/i);
});
