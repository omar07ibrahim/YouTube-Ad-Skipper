"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COUNT_KEY,
  MAX_COUNT,
  RECENT_ACTION_LIMIT,
  STATE_KEY,
  STATE_SCHEMA_VERSION,
  createHandlers,
  formatBadgeCount,
  initializeState,
  isActionId,
  isExactCounterState,
  isTrustedSkipMessage,
  nextCount,
  normalizeCount,
  normalizeRecentActionIds,
  recordSkipAction,
  registerBackground,
} = require("../background.js");

function actionId(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function counterState(count, recentActionIds = []) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    count,
    recentActionIds: [...recentActionIds],
  };
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function createChrome(initial = {}) {
  const data = clone(initial);
  const badgeColors = [];
  const badgeTexts = [];
  const accessLevels = [];
  const removals = [];
  const sets = [];
  const listeners = {
    installed: [],
    messages: [],
    startup: [],
  };

  return {
    action: {
      async setBadgeBackgroundColor({ color }) {
        badgeColors.push(color);
      },
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
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
              .map((key) => [key, clone(data[key])]),
          );
        },
        async remove(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          removals.push(...requested);
          for (const key of requested) {
            delete data[key];
          }
        },
        async set(values) {
          const copied = clone(values);
          sets.push(copied);
          Object.assign(data, copied);
        },
        async setAccessLevel(value) {
          accessLevels.push(value);
        },
      },
    },
    test: {
      accessLevels,
      badgeColors,
      badgeTexts,
      data,
      listeners,
      removals,
      sets,
    },
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

function request(id = actionId(1)) {
  return { type: "skip-action", actionId: id };
}

test("count, action IDs, and badge formatting are bounded", () => {
  assert.equal(normalizeCount(17), 17);
  assert.equal(normalizeCount(-1), 0);
  assert.equal(normalizeCount(1.5), 0);
  assert.equal(normalizeCount("17"), 0);
  assert.equal(nextCount(MAX_COUNT), MAX_COUNT);
  assert.equal(formatBadgeCount(0), "0");
  assert.equal(formatBadgeCount(999), "999");
  assert.equal(formatBadgeCount(1_000), "999+");
  assert.equal(isActionId(actionId(1)), true);
  assert.equal(isActionId(actionId(0xabc).toUpperCase()), false);
  assert.equal(
    isActionId("00000000-0000-7000-8000-000000000001"),
    false,
  );
  assert.equal(
    isActionId("00000000-0000-4000-7000-000000000001"),
    false,
  );
});

test("initialization migrates and removes a valid legacy count", async () => {
  const chromeApi = createChrome({ [COUNT_KEY]: 17 });

  assert.equal(await initializeState(chromeApi), 17);
  assert.deepEqual(chromeApi.test.data, {
    [STATE_KEY]: counterState(17),
  });
  assert.deepEqual(chromeApi.test.sets, [
    { [STATE_KEY]: counterState(17) },
  ]);
  assert.deepEqual(chromeApi.test.removals, [COUNT_KEY]);
  assert.deepEqual(chromeApi.test.badgeTexts, ["17"]);
  assert.deepEqual(chromeApi.test.accessLevels, [
    { accessLevel: "TRUSTED_CONTEXTS" },
  ]);
});

test("a valid counter state is authoritative over leftover legacy data", async () => {
  const existing = counterState(23, [actionId(1)]);
  const chromeApi = createChrome({
    [COUNT_KEY]: 99,
    [STATE_KEY]: existing,
  });

  assert.equal(await initializeState(chromeApi), 23);
  assert.deepEqual(chromeApi.test.data, { [STATE_KEY]: existing });
  assert.deepEqual(chromeApi.test.sets, []);
  assert.deepEqual(chromeApi.test.removals, [COUNT_KEY]);
  assert.deepEqual(chromeApi.test.badgeTexts, ["23"]);
});

test("initialization repairs corrupt state into the exact schema", async () => {
  const first = actionId(1);
  const second = actionId(2);
  const chromeApi = createChrome({
    [COUNT_KEY]: 7,
    [STATE_KEY]: {
      schemaVersion: STATE_SCHEMA_VERSION,
      count: "corrupt",
      recentActionIds: [first, "NOT-A-UUID", second, first],
      extra: true,
    },
  });

  assert.equal(await initializeState(chromeApi), 7);
  assert.deepEqual(chromeApi.test.data, {
    [STATE_KEY]: counterState(7, [second, first]),
  });
  assert.equal(isExactCounterState(chromeApi.test.data[STATE_KEY]), true);
  assert.deepEqual(chromeApi.test.removals, [COUNT_KEY]);
});

test("unsupported future state schemas fail closed without mutation", async () => {
  for (const schemaVersion of [2, Number.MAX_SAFE_INTEGER + 1]) {
    const futureState = {
      schemaVersion,
      count: 81,
      recentActionIds: [actionId(1)],
    };
    const chromeApi = createChrome({
      [COUNT_KEY]: 7,
      [STATE_KEY]: futureState,
    });

    await assert.rejects(initializeState(chromeApi), {
      message: "unsupported counter state schema",
    });
    assert.deepEqual(chromeApi.test.data, {
      [COUNT_KEY]: 7,
      [STATE_KEY]: futureState,
    });
    assert.deepEqual(chromeApi.test.sets, []);
    assert.deepEqual(chromeApi.test.removals, []);
    assert.deepEqual(chromeApi.test.badgeTexts, []);
  }
});

test("recent ID normalization keeps the newest 256 unique valid IDs", () => {
  const ids = Array.from(
    { length: RECENT_ACTION_LIMIT + 2 },
    (_, index) => actionId(index),
  );
  const normalized = normalizeRecentActionIds([
    ids[0],
    ...ids,
    "invalid",
    ids.at(-1),
  ]);

  assert.equal(normalized.length, RECENT_ACTION_LIMIT);
  assert.equal(normalized[0], ids[2]);
  assert.equal(normalized.at(-1), ids.at(-1));
  assert.equal(new Set(normalized).size, RECENT_ACTION_LIMIT);
});

test("registration stays synchronous and update initialization preserves state", async () => {
  const existing = counterState(23, [actionId(1)]);
  const chromeApi = createChrome({ [STATE_KEY]: existing });
  const handlers = registerBackground(chromeApi);

  assert.equal(chromeApi.test.listeners.installed.length, 1);
  assert.equal(chromeApi.test.listeners.messages.length, 1);
  assert.equal(chromeApi.test.listeners.startup.length, 1);
  await handlers.whenIdle();
  chromeApi.test.listeners.installed[0]({ reason: "update" });
  await handlers.whenIdle();
  assert.deepEqual(chromeApi.test.data[STATE_KEY], existing);
  assert.deepEqual(chromeApi.test.badgeTexts, ["23", "23"]);
});

test("a message re-establishes trusted storage access after initialization fails", async () => {
  const chromeApi = createChrome({ [STATE_KEY]: counterState(0) });
  const originalSetAccessLevel = chromeApi.storage.local.setAccessLevel;
  const originalGet = chromeApi.storage.local.get;
  let accessAttempts = 0;
  chromeApi.storage.local.setAccessLevel = async (details) => {
    accessAttempts += 1;
    if (accessAttempts === 1) {
      throw new Error("access setup unavailable");
    }
    return originalSetAccessLevel(details);
  };
  chromeApi.storage.local.get = async (keys) => {
    assert.equal(accessAttempts, 2);
    return originalGet(keys);
  };
  const handlers = registerBackground(chromeApi);
  const responses = [];
  const id = actionId(1);

  chromeApi.test.listeners.messages[0](
    request(id),
    trustedSender(),
    (response) => responses.push(response),
  );
  await handlers.whenIdle();

  assert.equal(accessAttempts, 2);
  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(1, [id]));
  assert.deepEqual(responses, [
    { ok: true, actionId: id, count: 1, duplicate: false },
  ]);
});

test("message validation requires an exact lowercase UUID and trusted sender", () => {
  const valid = request();
  assert.equal(
    isTrustedSkipMessage(valid, trustedSender(), "extension-id"),
    true,
  );

  for (const invalid of [
    { type: "skip-action" },
    { ...valid, extra: true },
    { ...valid, actionId: actionId(0xabc).toUpperCase() },
    { ...valid, actionId: valid.actionId.replaceAll("-", "") },
    { ...valid, actionId: `${valid.actionId}0` },
    { ...valid, actionId: null },
    { ...valid, type: "legacy-message" },
  ]) {
    assert.equal(
      isTrustedSkipMessage(invalid, trustedSender(), "extension-id"),
      false,
    );
  }

  const inheritedActionId = Object.create({ actionId: valid.actionId });
  inheritedActionId.type = "skip-action";
  inheritedActionId.extra = true;
  assert.equal(
    isTrustedSkipMessage(
      inheritedActionId,
      trustedSender(),
      "extension-id",
    ),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(
      Object.assign(Object.create(null), valid),
      trustedSender(),
      "extension-id",
    ),
    true,
  );

  assert.equal(
    isTrustedSkipMessage(valid, trustedSender({ frameId: 2 }), "extension-id"),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(valid, trustedSender({ id: "other" }), "extension-id"),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(
      valid,
      trustedSender({ url: "https://example.com/" }),
      "extension-id",
    ),
    false,
  );
  assert.equal(
    isTrustedSkipMessage(valid, { id: "extension-id" }, "extension-id"),
    false,
  );
});

test("concurrent distinct actions serialize without a lost increment", async () => {
  const chromeApi = createChrome({ [STATE_KEY]: counterState(0) });
  const handlers = createHandlers(chromeApi);
  const responses = [];
  const first = actionId(1);
  const second = actionId(2);

  assert.equal(
    handlers.onMessage(
      request(first),
      trustedSender(),
      (response) => responses.push(response),
    ),
    true,
  );
  assert.equal(
    handlers.onMessage(
      request(second),
      trustedSender(),
      (response) => responses.push(response),
    ),
    true,
  );

  await handlers.whenIdle();
  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(2, [first, second]));
  assert.deepEqual(responses, [
    { ok: true, actionId: first, count: 1, duplicate: false },
    { ok: true, actionId: second, count: 2, duplicate: false },
  ]);
  assert.deepEqual(chromeApi.test.badgeTexts, ["1", "2"]);
});

test("a duplicate action does not increment and always reapplies the badge", async () => {
  const chromeApi = createChrome({ [STATE_KEY]: counterState(0) });
  const handlers = createHandlers(chromeApi);
  const responses = [];
  const id = actionId(1);

  handlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  handlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  await handlers.whenIdle();

  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(1, [id]));
  assert.equal(chromeApi.test.sets.length, 1);
  assert.deepEqual(chromeApi.test.badgeTexts, ["1", "1"]);
  assert.deepEqual(responses, [
    { ok: true, actionId: id, count: 1, duplicate: false },
    { ok: true, actionId: id, count: 1, duplicate: true },
  ]);
});

test("a new action evicts only the oldest ID at the 256-entry bound", async () => {
  const existingIds = Array.from(
    { length: RECENT_ACTION_LIMIT },
    (_, index) => actionId(index),
  );
  const nextId = actionId(RECENT_ACTION_LIMIT);
  const chromeApi = createChrome({
    [STATE_KEY]: counterState(RECENT_ACTION_LIMIT, existingIds),
  });

  assert.deepEqual(await recordSkipAction(chromeApi, nextId), {
    actionId: nextId,
    count: 257,
    duplicate: false,
  });
  const stored = chromeApi.test.data[STATE_KEY];
  assert.equal(stored.recentActionIds.length, RECENT_ACTION_LIMIT);
  assert.deepEqual(stored.recentActionIds, [...existingIds.slice(1), nextId]);
  assert.equal(stored.count, 257);
});

test("a duplicate in a full window remains idempotent without rewriting state", async () => {
  const existingIds = Array.from(
    { length: RECENT_ACTION_LIMIT },
    (_, index) => actionId(index),
  );
  const chromeApi = createChrome({
    [STATE_KEY]: counterState(RECENT_ACTION_LIMIT, existingIds),
  });

  assert.deepEqual(await recordSkipAction(chromeApi, existingIds[0]), {
    actionId: existingIds[0],
    count: RECENT_ACTION_LIMIT,
    duplicate: true,
  });
  assert.deepEqual(
    chromeApi.test.data[STATE_KEY],
    counterState(RECENT_ACTION_LIMIT, existingIds),
  );
  assert.deepEqual(chromeApi.test.sets, []);
  assert.deepEqual(chromeApi.test.badgeTexts, [String(RECENT_ACTION_LIMIT)]);
});

test("retry after a badge failure repairs the badge without double counting", async () => {
  const chromeApi = createChrome({ [STATE_KEY]: counterState(0) });
  const originalSetBadgeText = chromeApi.action.setBadgeText;
  let failOnce = true;
  chromeApi.action.setBadgeText = async (details) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("badge unavailable");
    }
    return originalSetBadgeText(details);
  };
  const handlers = createHandlers(chromeApi);
  const responses = [];
  const id = actionId(1);

  handlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  await handlers.whenIdle();
  assert.deepEqual(responses, [{ ok: false }]);
  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(1, [id]));

  const restartedHandlers = createHandlers(chromeApi);
  restartedHandlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  await restartedHandlers.whenIdle();

  assert.deepEqual(responses, [
    { ok: false },
    { ok: true, actionId: id, count: 1, duplicate: true },
  ]);
  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(1, [id]));
  assert.equal(chromeApi.test.sets.length, 1);
  assert.deepEqual(chromeApi.test.badgeTexts, ["1"]);
});

test("retry after legacy removal failure uses the committed state once", async () => {
  const chromeApi = createChrome({ [COUNT_KEY]: 5 });
  const originalRemove = chromeApi.storage.local.remove;
  let failOnce = true;
  chromeApi.storage.local.remove = async (keys) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("legacy cleanup unavailable");
    }
    return originalRemove(keys);
  };
  const id = actionId(1);
  const responses = [];
  const firstHandlers = createHandlers(chromeApi);

  firstHandlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  await firstHandlers.whenIdle();
  assert.deepEqual(responses, [{ ok: false }]);
  assert.deepEqual(chromeApi.test.data, {
    [COUNT_KEY]: 5,
    [STATE_KEY]: counterState(6, [id]),
  });

  const restartedHandlers = createHandlers(chromeApi);
  restartedHandlers.onMessage(request(id), trustedSender(), (response) =>
    responses.push(response),
  );
  await restartedHandlers.whenIdle();

  assert.deepEqual(responses, [
    { ok: false },
    { ok: true, actionId: id, count: 6, duplicate: true },
  ]);
  assert.deepEqual(chromeApi.test.data, {
    [STATE_KEY]: counterState(6, [id]),
  });
  assert.equal(chromeApi.test.sets.length, 1);
  assert.deepEqual(chromeApi.test.badgeTexts, ["6"]);
});

test("a new action orders state write and legacy removal before badge acknowledgement", async () => {
  const chromeApi = createChrome({ [COUNT_KEY]: 3 });
  const events = [];
  const originalSet = chromeApi.storage.local.set;
  const originalRemove = chromeApi.storage.local.remove;
  const originalSetBadgeBackgroundColor =
    chromeApi.action.setBadgeBackgroundColor;
  const originalSetBadgeText = chromeApi.action.setBadgeText;
  chromeApi.storage.local.set = async (values) => {
    events.push("state:set");
    return originalSet(values);
  };
  chromeApi.storage.local.remove = async (keys) => {
    events.push("legacy:remove");
    return originalRemove(keys);
  };
  chromeApi.action.setBadgeBackgroundColor = async (details) => {
    events.push("badge:color");
    return originalSetBadgeBackgroundColor(details);
  };
  chromeApi.action.setBadgeText = async (details) => {
    events.push("badge:text");
    return originalSetBadgeText(details);
  };

  const result = await recordSkipAction(chromeApi, actionId(1));

  assert.deepEqual(result, {
    actionId: actionId(1),
    count: 4,
    duplicate: false,
  });
  assert.deepEqual(events, [
    "state:set",
    "legacy:remove",
    "badge:color",
    "badge:text",
  ]);
});

test("an invalid direct action ID fails before storage access or mutation", async () => {
  const existing = counterState(2, [actionId(1)]);
  const chromeApi = createChrome({ [STATE_KEY]: existing });

  await assert.rejects(recordSkipAction(chromeApi, "not-a-uuid"), {
    name: "TypeError",
    message: "actionId must be a lowercase UUIDv4",
  });
  assert.deepEqual(chromeApi.test.data[STATE_KEY], existing);
  assert.deepEqual(chromeApi.test.accessLevels, []);
  assert.deepEqual(chromeApi.test.sets, []);
  assert.deepEqual(chromeApi.test.badgeTexts, []);
});

test("a failed write does not poison the serialization queue", async () => {
  const chromeApi = createChrome({ [STATE_KEY]: counterState(0) });
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
  const first = actionId(1);
  const second = actionId(2);

  handlers.onMessage(request(first), trustedSender(), (response) =>
    responses.push(response),
  );
  handlers.onMessage(request(second), trustedSender(), (response) =>
    responses.push(response),
  );
  await handlers.whenIdle();

  assert.deepEqual(responses, [
    { ok: false },
    { ok: true, actionId: second, count: 1, duplicate: false },
  ]);
  assert.deepEqual(chromeApi.test.data[STATE_KEY], counterState(1, [second]));
  assert.deepEqual(chromeApi.test.badgeTexts, ["1"]);
});

test("ignored messages are synchronous and have no side effects", async () => {
  const existing = counterState(9, [actionId(1)]);
  const chromeApi = createChrome({ [STATE_KEY]: existing });
  const handlers = createHandlers(chromeApi);
  let responded = false;
  const accepted = handlers.onMessage(
    { type: "legacy-message", actionId: actionId(2) },
    trustedSender(),
    () => {
      responded = true;
    },
  );

  assert.equal(accepted, false);
  await handlers.whenIdle();
  assert.equal(responded, false);
  assert.deepEqual(chromeApi.test.data[STATE_KEY], existing);
  assert.deepEqual(chromeApi.test.sets, []);
  assert.deepEqual(chromeApi.test.badgeTexts, []);
});
