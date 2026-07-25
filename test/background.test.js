"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_COUNT,
  createHandlers,
  formatBadgeCount,
  initializeState,
  isTrustedSkipMessage,
  nextCount,
  normalizeCount,
  registerBackground,
} = require("../background.js");

function createChrome(initial = {}) {
  const data = { ...initial };
  const badgeTexts = [];
  const accessLevels = [];
  const listeners = {
    installed: [],
    messages: [],
    startup: [],
  };

  return {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText({ text }) {
        badgeTexts.push(text);
      },
    },
    runtime: {
      id: "extension-id",
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onMessage: { addListener: (listener) => listeners.messages.push(listener) },
      onStartup: { addListener: (listener) => listeners.startup.push(listener) },
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.map((key) => [key, data[key]]));
        },
        async set(values) {
          Object.assign(data, values);
        },
        async setAccessLevel(value) {
          accessLevels.push(value);
        },
      },
    },
    test: { accessLevels, badgeTexts, data, listeners },
  };
}

function trustedSender(overrides = {}) {
  return {
    frameId: 0,
    id: "extension-id",
    tab: { id: 7 },
    url: "https://www.youtube.com/watch?v=fixture",
    ...overrides,
  };
}

test("count normalization and badge formatting are bounded", () => {
  assert.equal(normalizeCount(17), 17);
  assert.equal(normalizeCount(-1), 0);
  assert.equal(normalizeCount(1.5), 0);
  assert.equal(normalizeCount("17"), 0);
  assert.equal(nextCount(MAX_COUNT), MAX_COUNT);
  assert.equal(formatBadgeCount(0), "0");
  assert.equal(formatBadgeCount(999), "999");
  assert.equal(formatBadgeCount(1_000), "999+");
});

test("initialization preserves a valid count and restricts storage access", async () => {
  const chromeApi = createChrome({ adsSkipped: 17 });
  assert.equal(await initializeState(chromeApi), 17);
  assert.equal(chromeApi.test.data.adsSkipped, 17);
  assert.deepEqual(chromeApi.test.badgeTexts, ["17"]);
  assert.deepEqual(chromeApi.test.accessLevels, [
    { accessLevel: "TRUSTED_CONTEXTS" },
  ]);
});

test("initialization repairs a corrupt count without resetting valid updates", async () => {
  const chromeApi = createChrome({ adsSkipped: -4 });
  assert.equal(await initializeState(chromeApi), 0);
  assert.equal(chromeApi.test.data.adsSkipped, 0);
});

test("registration is synchronous and an update-style initialization preserves state", async () => {
  const chromeApi = createChrome({ adsSkipped: 23 });
  const handlers = registerBackground(chromeApi);

  assert.equal(chromeApi.test.listeners.installed.length, 1);
  assert.equal(chromeApi.test.listeners.messages.length, 1);
  assert.equal(chromeApi.test.listeners.startup.length, 1);
  await handlers.whenIdle();
  chromeApi.test.listeners.installed[0]({ reason: "update" });
  await handlers.whenIdle();
  assert.equal(chromeApi.test.data.adsSkipped, 23);
});

test("message validation accepts only an exact top-frame YouTube message", () => {
  const request = { type: "skip-action" };
  assert.equal(
    isTrustedSkipMessage(request, trustedSender(), "extension-id"),
    true,
  );
  assert.equal(
    isTrustedSkipMessage({ ...request, extra: true }, trustedSender(), "extension-id"),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(request, trustedSender({ frameId: 2 }), "extension-id"),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(request, trustedSender({ id: "other" }), "extension-id"),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(
      request,
      trustedSender({ url: "https://example.com/" }),
      "extension-id",
    ),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(request, { id: "extension-id" }, "extension-id"),
    false,
  );
});

test("concurrent accepted messages are serialized without lost increments", async () => {
  const chromeApi = createChrome({ adsSkipped: 0 });
  const handlers = createHandlers(chromeApi);
  const responses = [];

  const firstAccepted = handlers.onMessage(
    { type: "skip-action" },
    trustedSender(),
    (response) => responses.push(response),
  );
  const secondAccepted = handlers.onMessage(
    { type: "skip-action" },
    trustedSender(),
    (response) => responses.push(response),
  );

  assert.equal(firstAccepted, true);
  assert.equal(secondAccepted, true);
  await handlers.whenIdle();
  assert.equal(chromeApi.test.data.adsSkipped, 2);
  assert.deepEqual(responses, [
    { ok: true, count: 1 },
    { ok: true, count: 2 },
  ]);
  assert.deepEqual(chromeApi.test.badgeTexts, ["1", "2"]);
});

test("ignored messages are synchronous and have no side effects", async () => {
  const chromeApi = createChrome({ adsSkipped: 9 });
  const handlers = createHandlers(chromeApi);
  let responded = false;
  const accepted = handlers.onMessage(
    { type: "legacy-message" },
    trustedSender(),
    () => {
      responded = true;
    },
  );

  assert.equal(accepted, false);
  await handlers.whenIdle();
  assert.equal(responded, false);
  assert.equal(chromeApi.test.data.adsSkipped, 9);
});

test("a failed operation does not poison the serialization queue", async () => {
  const chromeApi = createChrome({ adsSkipped: 0 });
  const originalSet = chromeApi.storage.local.set;
  let failOnce = true;
  chromeApi.storage.local.set = async (values) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("storage unavailable");
    }
    return originalSet(values);
  };
  const handlers = createHandlers(chromeApi);
  const responses = [];

  handlers.onMessage(
    { type: "skip-action" },
    trustedSender(),
    (response) => responses.push(response),
  );
  handlers.onMessage(
    { type: "skip-action" },
    trustedSender(),
    (response) => responses.push(response),
  );
  await handlers.whenIdle();

  assert.deepEqual(responses, [{ ok: false }, { ok: true, count: 1 }]);
  assert.equal(chromeApi.test.data.adsSkipped, 1);
});
