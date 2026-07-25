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
  const MESSAGE_TYPE = "skip-action";
  const BADGE_COLOR = "#dc2626";
  const MAX_COUNT = Number.MAX_SAFE_INTEGER;

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

  function isTrustedSkipMessage(request, sender, runtimeId) {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).length !== 1 ||
      request.type !== MESSAGE_TYPE
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
    if (typeof chromeApi.storage.local.setAccessLevel === "function") {
      await chromeApi.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
    }

    const stored = await chromeApi.storage.local.get([COUNT_KEY]);
    const count = normalizeCount(stored[COUNT_KEY]);

    if (stored[COUNT_KEY] !== count) {
      await chromeApi.storage.local.set({ [COUNT_KEY]: count });
    }

    await applyBadge(chromeApi, count);
    return count;
  }

  async function incrementCount(chromeApi) {
    const stored = await chromeApi.storage.local.get([COUNT_KEY]);
    const count = nextCount(stored[COUNT_KEY]);
    await chromeApi.storage.local.set({ [COUNT_KEY]: count });
    await applyBadge(chromeApi, count);
    return count;
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

      enqueue(() => incrementCount(chromeApi)).then(
        (count) => sendResponse({ ok: true, count }),
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
    MAX_COUNT,
    MESSAGE_TYPE,
    createHandlers,
    formatBadgeCount,
    incrementCount,
    initializeState,
    isTrustedSkipMessage,
    nextCount,
    normalizeCount,
    registerBackground,
  };
});
