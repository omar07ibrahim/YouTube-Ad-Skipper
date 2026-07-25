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

  function normalizeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function formatDisplayCount(value) {
    const count = normalizeCount(value);
    return count > 999 ? "999+" : String(count);
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

    let observedChanges = 0;
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[COUNT_KEY]) {
        observedChanges += 1;
        renderCount(countElement, changes[COUNT_KEY].newValue);
      }
    });

    const changeVersionAtRead = observedChanges;
    try {
      const stored = await chromeApi.storage.local.get([COUNT_KEY]);
      if (observedChanges === changeVersionAtRead) {
        renderCount(countElement, stored[COUNT_KEY]);
      }
    } catch {
      if (observedChanges === changeVersionAtRead) {
        renderError(countElement);
      }
    }
  }

  return {
    COUNT_KEY,
    bootstrap,
    formatDisplayCount,
    normalizeCount,
    renderCount,
    renderError,
  };
});
