(function exposeBackground(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  api.registerBackground(root.chrome);
})(typeof globalThis === "object" ? globalThis : this, function createBackgroundApi() {
  "use strict";

  const COUNT_KEY = "adsSkipped";
  const STATE_KEY = "counterState";
  const STATE_SCHEMA_VERSION = 1;
  const RECENT_ACTION_LIMIT = 256;
  const MESSAGE_TYPE = "skip-action";
  const BADGE_COLOR = "#dc2626";
  const MAX_COUNT = Number.MAX_SAFE_INTEGER;
  const ACTION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function normalizeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function nextCount(value) {
    return Math.min(normalizeCount(value) + 1, MAX_COUNT);
  }

  function formatBadgeCount(value) {
    const count = normalizeCount(value);
    return count > 999 ? "999+" : String(count);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isActionId(value) {
    return typeof value === "string" && ACTION_ID_PATTERN.test(value);
  }

  function normalizeRecentActionIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const seen = new Set();
    const newestFirst = [];
    for (
      let index = value.length - 1;
      index >= 0 && newestFirst.length < RECENT_ACTION_LIMIT;
      index -= 1
    ) {
      const actionId = value[index];
      if (isActionId(actionId) && !seen.has(actionId)) {
        seen.add(actionId);
        newestFirst.push(actionId);
      }
    }
    return newestFirst.reverse();
  }

  function createCounterState(count, recentActionIds = []) {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      count: normalizeCount(count),
      recentActionIds: normalizeRecentActionIds(recentActionIds),
    };
  }

  function isExactCounterState(value) {
    if (!isPlainObject(value)) {
      return false;
    }
    const keys = Object.keys(value).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "count" ||
      keys[1] !== "recentActionIds" ||
      keys[2] !== "schemaVersion" ||
      value.schemaVersion !== STATE_SCHEMA_VERSION ||
      normalizeCount(value.count) !== value.count ||
      !Array.isArray(value.recentActionIds) ||
      value.recentActionIds.length > RECENT_ACTION_LIMIT
    ) {
      return false;
    }

    const uniqueIds = new Set(value.recentActionIds);
    return (
      uniqueIds.size === value.recentActionIds.length &&
      value.recentActionIds.every(isActionId)
    );
  }

  function sameCounterState(left, right) {
    return (
      isExactCounterState(left) &&
      left.count === right.count &&
      left.recentActionIds.length === right.recentActionIds.length &&
      left.recentActionIds.every(
        (actionId, index) => actionId === right.recentActionIds[index],
      )
    );
  }

  function resolveStoredState(stored) {
    const rawState = stored[STATE_KEY];
    if (
      isPlainObject(rawState) &&
      typeof rawState.schemaVersion === "number" &&
      rawState.schemaVersion !== STATE_SCHEMA_VERSION
    ) {
      throw new Error("unsupported counter state schema");
    }
    const hasCompatibleState =
      isPlainObject(rawState) &&
      rawState.schemaVersion === STATE_SCHEMA_VERSION;
    const count =
      hasCompatibleState && normalizeCount(rawState.count) === rawState.count
        ? rawState.count
        : normalizeCount(stored[COUNT_KEY]);
    const recentActionIds = hasCompatibleState
      ? normalizeRecentActionIds(rawState.recentActionIds)
      : [];
    const state = createCounterState(count, recentActionIds);

    return {
      hasLegacyCount: Object.prototype.hasOwnProperty.call(stored, COUNT_KEY),
      needsWrite: !sameCounterState(rawState, state),
      state,
    };
  }

  async function readStoredState(chromeApi) {
    const stored = await chromeApi.storage.local.get([STATE_KEY, COUNT_KEY]);
    return resolveStoredState(stored);
  }

  async function removeLegacyCount(chromeApi, hasLegacyCount) {
    if (hasLegacyCount) {
      await chromeApi.storage.local.remove(COUNT_KEY);
    }
  }

  async function persistResolvedState(chromeApi, resolved) {
    if (resolved.needsWrite) {
      await chromeApi.storage.local.set({ [STATE_KEY]: resolved.state });
    }
    await removeLegacyCount(chromeApi, resolved.hasLegacyCount);
    return resolved.state;
  }

  async function ensureTrustedStorageAccess(chromeApi) {
    if (typeof chromeApi.storage.local.setAccessLevel === "function") {
      await chromeApi.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
    }
  }

  function isTrustedSkipMessage(request, sender, runtimeId) {
    const requestKeys = isPlainObject(request)
      ? Object.keys(request).sort()
      : [];
    if (
      requestKeys.length !== 2 ||
      requestKeys[0] !== "actionId" ||
      requestKeys[1] !== "type" ||
      request.type !== MESSAGE_TYPE ||
      !isActionId(request.actionId)
    ) {
      return false;
    }

    if (
      !sender ||
      sender.id !== runtimeId ||
      sender.frameId !== 0 ||
      !sender.tab ||
      typeof sender.url !== "string"
    ) {
      return false;
    }

    try {
      const url = new URL(sender.url);
      return url.protocol === "https:" && url.hostname === "www.youtube.com";
    } catch {
      return false;
    }
  }

  async function applyBadge(chromeApi, count) {
    await chromeApi.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chromeApi.action.setBadgeText({ text: formatBadgeCount(count) });
  }

  async function initializeState(chromeApi) {
    await ensureTrustedStorageAccess(chromeApi);
    const resolved = await readStoredState(chromeApi);
    const state = await persistResolvedState(chromeApi, resolved);
    await applyBadge(chromeApi, state.count);
    return state.count;
  }

  async function recordSkipAction(chromeApi, actionId) {
    if (!isActionId(actionId)) {
      throw new TypeError("actionId must be a lowercase UUIDv4");
    }

    await ensureTrustedStorageAccess(chromeApi);
    const resolved = await readStoredState(chromeApi);
    const current = resolved.state;

    if (current.recentActionIds.includes(actionId)) {
      await persistResolvedState(chromeApi, resolved);
      await applyBadge(chromeApi, current.count);
      return {
        actionId,
        count: current.count,
        duplicate: true,
      };
    }

    const state = createCounterState(nextCount(current.count), [
      ...current.recentActionIds,
      actionId,
    ]);
    await chromeApi.storage.local.set({ [STATE_KEY]: state });
    await removeLegacyCount(chromeApi, resolved.hasLegacyCount);
    await applyBadge(chromeApi, state.count);
    return {
      actionId,
      count: state.count,
      duplicate: false,
    };
  }

  async function incrementCount(chromeApi, actionId) {
    return (await recordSkipAction(chromeApi, actionId)).count;
  }

  function createHandlers(chromeApi) {
    let queue = Promise.resolve();

    function enqueue(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => undefined);
      return result;
    }

    function initialize() {
      return enqueue(() => initializeState(chromeApi));
    }

    function onInstalled() {
      initialize().catch(() => undefined);
    }

    function onStartup() {
      initialize().catch(() => undefined);
    }

    function onMessage(request, sender, sendResponse) {
      if (!isTrustedSkipMessage(request, sender, chromeApi.runtime.id)) {
        return false;
      }

      enqueue(() => recordSkipAction(chromeApi, request.actionId)).then(
        ({ actionId, count, duplicate }) =>
          sendResponse({ ok: true, actionId, count, duplicate }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    return {
      initialize,
      onInstalled,
      onMessage,
      onStartup,
      whenIdle: () => queue,
    };
  }

  function registerBackground(chromeApi) {
    const handlers = createHandlers(chromeApi);
    chromeApi.runtime.onInstalled.addListener(handlers.onInstalled);
    chromeApi.runtime.onStartup.addListener(handlers.onStartup);
    chromeApi.runtime.onMessage.addListener(handlers.onMessage);
    handlers.initialize().catch(() => undefined);
    return handlers;
  }

  return {
    COUNT_KEY,
    RECENT_ACTION_LIMIT,
    STATE_KEY,
    STATE_SCHEMA_VERSION,
    MAX_COUNT,
    MESSAGE_TYPE,
    createCounterState,
    createHandlers,
    ensureTrustedStorageAccess,
    formatBadgeCount,
    incrementCount,
    initializeState,
    isActionId,
    isExactCounterState,
    isTrustedSkipMessage,
    nextCount,
    normalizeCount,
    normalizeRecentActionIds,
    recordSkipAction,
    registerBackground,
    resolveStoredState,
  };
});
