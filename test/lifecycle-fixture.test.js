"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const fixture = import("../scripts/lifecycle-fixture.mjs");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
    if (this.tagName === "VIDEO") {
      this.currentSrc = "";
      this.currentTime = 0;
      this.duration = Number.NaN;
      this.playbackRate = 1;
      this.src = "";
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener),
    );
  }

  dispatch(type) {
    const listeners = [...(this.listeners.get(type) || [])];
    for (const entry of listeners) {
      entry.listener.call(this);
      if (entry.once) {
        this.removeEventListener(type, entry.listener);
      }
    }
  }

  append(...elements) {
    for (const element of elements) {
      if (element.parentElement) {
        element.remove();
      }
      element.parentElement = this;
      element.setConnected(this.isConnected);
      this.children.push(element);
    }
  }

  replaceChildren(...elements) {
    for (const child of this.children) {
      child.parentElement = null;
      child.setConnected(false);
    }
    this.children = [];
    this.append(...elements);
  }

  remove() {
    if (!this.parentElement) {
      return;
    }
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
    this.setConnected(false);
  }

  setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) {
      child.setConnected(value);
    }
  }

  matches(selector) {
    const tagAndClass = selector.match(/^([a-z]+)\.([a-z0-9-]+)$/i);
    if (tagAndClass) {
      return (
        this.tagName === tagAndClass[1].toUpperCase() &&
        this.className.split(/\s+/).includes(tagAndClass[2])
      );
    }
    return false;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  getClientRects() {
    return this.isConnected && !this.hidden ? [{}] : [];
  }

  click() {
    if (this.tagName === "BUTTON" && !this.disabled) {
      this.dispatch("click");
    }
  }

  load() {
    if (this.tagName !== "VIDEO") {
      return;
    }
    queueMicrotask(() => {
      this.currentSrc = this.src;
      this.currentTime = 0;
      this.duration = 40;
      this.dispatch("loadedmetadata");
    });
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function inlineScript(html) {
  const match = html.match(/<script>\n([\s\S]+?)\n    <\/script>/);
  assert.ok(match, "fixture must contain one extractable inline script");
  assert.equal((html.match(/<script>/g) || []).length, 1);
  return match[1];
}

async function executeFixture(html) {
  const player = new FakeElement("section");
  const status = new FakeElement("p");
  player.setConnected(true);
  status.setConnected(true);
  const historyCalls = [];
  const revokedUrls = [];
  let objectUrlSequence = 0;
  const documentApi = {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => (id === "ytas-player" ? player : null),
    querySelector: (selector) =>
      selector === "[data-ytas-status]" ? status : null,
  };
  const windowApi = {};

  vm.runInNewContext(inlineScript(html), {
    Blob,
    URL: {
      createObjectURL() {
        objectUrlSequence += 1;
        return `blob:fixture-${objectUrlSequence}`;
      },
      revokeObjectURL(value) {
        revokedUrls.push(value);
      },
    },
    document: documentApi,
    history: {
      pushState(...args) {
        historyCalls.push(args);
      },
    },
    window: windowApi,
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (windowApi.__YTAS_LIFECYCLE_FIXTURE_V1__) {
      return {
        api: windowApi.__YTAS_LIFECYCLE_FIXTURE_V1__,
        historyCalls,
        player,
        revokedUrls,
      };
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture API did not become ready");
}

test("fixture exports an exact immutable URL and selector contract", async () => {
  const {
    LIFECYCLE_FIXTURE_URLS,
    LIFECYCLE_PAGE_API,
    LIFECYCLE_SELECTORS,
    matchLifecycleFixtureUrl,
  } = await fixture;

  assert.equal(LIFECYCLE_PAGE_API, "__YTAS_LIFECYCLE_FIXTURE_V1__");
  assert.deepEqual(LIFECYCLE_FIXTURE_URLS, {
    primary: "https://www.youtube.com/watch?v=ytas-lifecycle-primary",
    barrierA: "https://www.youtube.com/watch?v=ytas-lifecycle-barrier-a",
    barrierB: "https://www.youtube.com/watch?v=ytas-lifecycle-barrier-b",
    wake: "https://www.youtube.com/watch?v=ytas-lifecycle-wake",
  });
  assert.deepEqual(LIFECYCLE_SELECTORS, {
    root: '[data-ytas-fixture="lifecycle-v1"]',
    player: ".html5-video-player",
    video: "video.html5-main-video",
    skip: "button.ytp-ad-skip-button-modern",
    status: "[data-ytas-status]",
  });
  assert.equal(Object.isFrozen(LIFECYCLE_FIXTURE_URLS), true);
  assert.equal(Object.isFrozen(LIFECYCLE_SELECTORS), true);

  for (const [role, url] of Object.entries(LIFECYCLE_FIXTURE_URLS)) {
    assert.equal(matchLifecycleFixtureUrl(url), role);
    assert.equal(matchLifecycleFixtureUrl(`${url}#fragment`), null);
    assert.equal(matchLifecycleFixtureUrl(`${url}&extra=1`), null);
  }
  assert.equal(matchLifecycleFixtureUrl(new URL(LIFECYCLE_FIXTURE_URLS.wake)), null);
  assert.equal(matchLifecycleFixtureUrl(null), null);
});

test("rendering is deterministic, inline-only, and rejects injected roles", async () => {
  const { LIFECYCLE_FIXTURE_URLS, renderLifecycleFixture } = await fixture;
  const outputs = Object.keys(LIFECYCLE_FIXTURE_URLS).map((role) => {
    const first = renderLifecycleFixture(role);
    const second = renderLifecycleFixture(role);
    assert.equal(first, second);
    assert.match(first, /^<!doctype html>/);
    assert.match(first, /new Blob\(\[bytes\], \{ type: "audio\/wav" \}\)/);
    assert.match(first, /const sampleRate = 8000/);
    assert.match(first, /view\.setUint16\(34, 8, true\)/);
    assert.doesNotMatch(first, /<script[^>]+src=/i);
    assert.doesNotMatch(first, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/);
    assert.doesNotMatch(first, /\bchrome\s*\./);
    assert.doesNotMatch(first, /\b(?:localStorage|sessionStorage)\b/);
    assert.doesNotMatch(first, /\b(?:Math\.random|Date\.now|crypto\.randomUUID)\b/);
    assert.doesNotMatch(first, /Object\.defineProperty|__defineGetter__/);
    assert.doesNotMatch(first, /(?:src|href)=["']https?:/i);
    return first;
  });
  assert.equal(new Set(outputs).size, 4);

  for (const malicious of [
    "primary<script>alert(1)</script>",
    "__proto__",
    "toString",
    "barrier-a",
    "",
    null,
  ]) {
    assert.throws(
      () => renderLifecycleFixture(malicious),
      /unknown lifecycle fixture role/,
    );
  }
  const poison = { toString: () => assert.fail("must not coerce role") };
  assert.throws(
    () => renderLifecycleFixture(poison),
    /unknown lifecycle fixture role/,
  );
});

test("primary fixture exposes exact snapshots across SPA and ad-pod phases", async () => {
  const { renderLifecycleFixture } = await fixture;
  const { api, historyCalls, player, revokedUrls } = await executeFixture(
    renderLifecycleFixture("primary"),
  );

  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), [
    "schemaVersion",
    "role",
    "snapshot",
    "beginSpaLongAd",
    "releaseSpaSkip",
    "rotateAdPodAndRelease",
    "releaseGatedSkip",
  ]);
  assert.deepEqual(plain(api.snapshot()), {
    schemaVersion: 1,
    role: "primary",
    phase: "initial-ready",
    ready: true,
    playbackRate: 1,
    buttonEligible: true,
    clickCounts: { initial: 0, spa: 0, adPod: 0, gated: 0 },
    rateAtClick: { spa: null },
    sameDocument: true,
    sameVideoElement: false,
    sourceChanged: false,
  });

  player.querySelector("button.ytp-ad-skip-button-modern").click();
  assert.equal(api.snapshot().phase, "initial-clicked");
  assert.equal(api.snapshot().clickCounts.initial, 1);
  const initialVideo = player.querySelector("video.html5-main-video");

  await api.beginSpaLongAd();
  const spaVideo = player.querySelector("video.html5-main-video");
  assert.notEqual(spaVideo, initialVideo);
  assert.deepEqual(plain(historyCalls), [
    [
      { fixture: "lifecycle-v1" },
      "",
      "/watch?v=ytas-lifecycle-primary-spa",
    ],
  ]);
  assert.equal(api.snapshot().phase, "spa-gated");
  assert.equal(api.snapshot().buttonEligible, false);
  assert.deepEqual(revokedUrls, ["blob:fixture-1"]);

  spaVideo.playbackRate = 2;
  assert.equal(api.releaseSpaSkip().buttonEligible, true);
  spaVideo.playbackRate = 1;
  player.querySelector("button.ytp-ad-skip-button-modern").click();
  assert.equal(api.snapshot().clickCounts.spa, 1);
  assert.equal(api.snapshot().rateAtClick.spa, 1);

  const previousSource = spaVideo.currentSrc;
  await api.rotateAdPodAndRelease();
  assert.equal(player.querySelector("video.html5-main-video"), spaVideo);
  assert.notEqual(spaVideo.currentSrc, previousSource);
  assert.equal(api.snapshot().sameVideoElement, true);
  assert.equal(api.snapshot().sourceChanged, true);
  assert.equal(api.snapshot().buttonEligible, true);
  player.querySelector("button.ytp-ad-skip-button-modern").click();
  assert.deepEqual(plain(api.snapshot().clickCounts), {
    initial: 1,
    spa: 1,
    adPod: 1,
    gated: 0,
  });
  assert.equal(api.snapshot().phase, "ad-pod-clicked");
  assert.deepEqual(revokedUrls, ["blob:fixture-1", "blob:fixture-2"]);
});

test("barrier and wake fixtures keep one gated, one-shot native button", async () => {
  const { renderLifecycleFixture } = await fixture;

  for (const role of ["barrierA", "barrierB", "wake"]) {
    const { api, player } = await executeFixture(renderLifecycleFixture(role));
    const initial = plain(api.snapshot());
    assert.deepEqual(Object.keys(initial), [
      "schemaVersion",
      "role",
      "phase",
      "ready",
      "playbackRate",
      "buttonEligible",
      "clickCounts",
      "rateAtClick",
      "sameDocument",
      "sameVideoElement",
      "sourceChanged",
    ]);
    assert.equal(initial.role, role);
    assert.equal(initial.phase, "gated");
    assert.equal(initial.buttonEligible, false);
    assert.equal(initial.clickCounts.gated, 0);

    assert.equal(api.releaseGatedSkip().buttonEligible, true);
    const button = player.querySelector("button.ytp-ad-skip-button-modern");
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-disabled"), null);
    button.click();
    button.click();
    assert.equal(api.snapshot().phase, "gated-clicked");
    assert.equal(api.snapshot().clickCounts.gated, 1);
    assert.equal(api.snapshot().buttonEligible, false);

    await assert.rejects(api.beginSpaLongAd(), /primary-only/);
    await assert.rejects(api.rotateAdPodAndRelease(), /primary-only/);
    assert.throws(() => api.releaseSpaSkip(), /primary-only/);
    assert.throws(() => api.releaseGatedSkip(), /requires phase gated/);
  }
});

test("primary fixture rejects out-of-order and cross-role transitions", async () => {
  const { renderLifecycleFixture } = await fixture;
  const { api, player } = await executeFixture(renderLifecycleFixture("primary"));

  await assert.rejects(api.beginSpaLongAd(), /requires phase initial-clicked/);
  assert.throws(() => api.releaseSpaSkip(), /requires phase spa-gated/);
  await assert.rejects(
    api.rotateAdPodAndRelease(),
    /requires phase spa-clicked/,
  );
  assert.throws(() => api.releaseGatedSkip(), /unavailable on primary/);

  player.querySelector("button.ytp-ad-skip-button-modern").click();
  await api.beginSpaLongAd();
  await assert.rejects(api.beginSpaLongAd(), /requires phase initial-clicked/);
});
