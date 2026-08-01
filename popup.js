(function exposePopup(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  api.bootstrap(root.document, root.chrome);
})(typeof globalThis === "object" ? globalThis : this, function createPopupApi() {
  "use strict";

  const COUNT_KEY = "adsSkipped";
  const STATE_KEY = "counterState";
  const STATE_SCHEMA_VERSION = 1;
  const MAX_RECENT_ACTIONS = 256;
  const ACTION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function normalizeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function formatDisplayCount(value) {
    const count = normalizeCount(value);
    return count > 999 ? "999+" : String(count);
  }

  function isCounterState(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 3 &&
      value.schemaVersion === STATE_SCHEMA_VERSION &&
      normalizeCount(value.count) === value.count &&
      Array.isArray(value.recentActionIds) &&
      value.recentActionIds.length <= MAX_RECENT_ACTIONS &&
      new Set(value.recentActionIds).size === value.recentActionIds.length &&
      value.recentActionIds.every(
        (actionId) =>
          typeof actionId === "string" && ACTION_ID_PATTERN.test(actionId),
      )
    );
  }

  function hasUnsupportedCounterSchema(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.schemaVersion === "number" &&
      value.schemaVersion !== STATE_SCHEMA_VERSION
    );
  }

  function readCounterValue(stored) {
    if (hasUnsupportedCounterSchema(stored?.[STATE_KEY])) {
      throw new Error("unsupported counter state schema");
    }
    if (isCounterState(stored?.[STATE_KEY])) {
      return stored[STATE_KEY].count;
    }
    return normalizeCount(stored?.[COUNT_KEY]);
  }

  function renderCount(element, value) {
    const count = normalizeCount(value);
    element.textContent = formatDisplayCount(count);
    element.setAttribute("aria-label", `${count} skip actions recorded`);
    element.removeAttribute("data-state");
  }

  function renderError(element) {
    element.textContent = "—";
    element.setAttribute("aria-label", "Skip action count unavailable");
    element.setAttribute("data-state", "error");
  }

  async function bootstrap(documentApi, chromeApi) {
    const countElement = documentApi.getElementById("adsSkippedCount");
    if (!countElement) {
      return;
    }

    let stateChanges = 0;
    let legacyChanges = 0;
    let hasDurableState = false;
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes[STATE_KEY]) {
        stateChanges += 1;
        if (hasUnsupportedCounterSchema(changes[STATE_KEY].newValue)) {
          hasDurableState = true;
          renderError(countElement);
          return;
        }
        hasDurableState = isCounterState(changes[STATE_KEY].newValue);
        renderCount(
          countElement,
          hasDurableState ? changes[STATE_KEY].newValue.count : 0,
        );
        return;
      }
      if (changes[COUNT_KEY] && !hasDurableState) {
        legacyChanges += 1;
        renderCount(countElement, changes[COUNT_KEY].newValue);
      }
    });

    const stateVersionAtRead = stateChanges;
    const legacyVersionAtRead = legacyChanges;
    try {
      const stored = await chromeApi.storage.local.get([STATE_KEY, COUNT_KEY]);
      if (stateChanges === stateVersionAtRead && isCounterState(stored[STATE_KEY])) {
        hasDurableState = true;
        renderCount(countElement, stored[STATE_KEY].count);
      } else if (
        stateChanges === stateVersionAtRead &&
        legacyChanges === legacyVersionAtRead
      ) {
        renderCount(countElement, readCounterValue(stored));
      }
    } catch {
      if (
        stateChanges === stateVersionAtRead &&
        legacyChanges === legacyVersionAtRead
      ) {
        renderError(countElement);
      }
    }
  }

  return {
    COUNT_KEY,
    STATE_KEY,
    bootstrap,
    formatDisplayCount,
    hasUnsupportedCounterSchema,
    isCounterState,
    normalizeCount,
    readCounterValue,
    renderCount,
    renderError,
  };
});
