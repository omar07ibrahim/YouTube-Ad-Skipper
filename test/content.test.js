"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACCELERATION_GRACE_MS,
  INSTANCE_KEY,
  bootstrap,
  choosePlaybackRate,
  createController,
  isEligibleSkipButton,
} = require("../content.js");

function createButton(overrides = {}) {
  return {
    click() {},
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    hidden: false,
    isConnected: true,
    ...overrides,
  };
}

function createVideo(overrides = {}) {
  let playbackRate = overrides.playbackRate ?? 1;
  const writes = [];
  const video = {
    currentSrc: "https://www.youtube.com/ad-1",
    currentTime: 0,
    duration: 30,
    ...overrides,
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value) {
      writes.push(value);
      playbackRate = value;
    },
  };
  return {
    video,
    writes,
    setRateExternally(value) {
      playbackRate = value;
    },
  };
}

function createPage(video, { adActive = true, skipButton = null } = {}) {
  const player = {
    classList: { contains: (name) => name === "ad-showing" && adActive },
    querySelector: () => video,
    querySelectorAll: () => (skipButton ? [skipButton] : []),
  };
  return {
    querySelector: () => player,
  };
}

function createHarness({
  video,
  adActive = true,
  skipButton = null,
  now = 0,
  sendMessage = () => Promise.resolve(),
} = {}) {
  let time = now;
  const page = createPage(video, { adActive, skipButton });
  const controller = createController({
    documentApi: page,
    runtimeApi: { sendMessage },
    now: () => time,
    setTimeoutApi: () => 1,
    clearTimeoutApi: () => {},
  });
  return {
    controller,
    page,
    setTime: (value) => {
      time = value;
    },
  };
}

test("policy preserves the original rate during grace and short remainders", () => {
  const base = {
    originalRate: 1,
    duration: 30,
    currentTime: 0,
  };
  assert.equal(
    choosePlaybackRate({ ...base, adAgeMs: ACCELERATION_GRACE_MS - 1 }),
    1,
  );
  assert.equal(
    choosePlaybackRate({ ...base, adAgeMs: ACCELERATION_GRACE_MS }),
    2,
  );
  assert.equal(
    choosePlaybackRate({
      ...base,
      currentTime: 22,
      adAgeMs: ACCELERATION_GRACE_MS,
    }),
    1,
  );
});

test("policy does not slow a user rate and rejects unknown timing", () => {
  assert.equal(
    choosePlaybackRate({
      originalRate: 3,
      duration: 30,
      currentTime: 10,
      adAgeMs: 10_000,
    }),
    3,
  );
  assert.equal(
    choosePlaybackRate({
      originalRate: 1.5,
      duration: Number.NaN,
      currentTime: 0,
      adAgeMs: 10_000,
    }),
    1.5,
  );
  assert.equal(
    choosePlaybackRate({
      originalRate: Number.NaN,
      duration: 30,
      currentTime: 0,
      adAgeMs: 0,
    }),
    1,
  );
});

test("a long ad accelerates once and restores its original rate", () => {
  const { video, writes } = createVideo({ playbackRate: 1.5 });
  const harness = createHarness({ video });

  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.deepEqual(writes, [2]);

  harness.page.querySelector().classList.contains = () => false;
  harness.controller.evaluate();
  assert.deepEqual(writes, [2, 1.5]);
});

test("a manual rate override is preserved and disables re-acceleration", () => {
  const { video, writes } = createVideo();
  const harness = createHarness({ video });

  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  video.playbackRate = 1.25;
  harness.controller.evaluate();

  harness.page.querySelector().classList.contains = () => false;
  harness.controller.evaluate();
  assert.deepEqual(writes, [2, 1.25]);
  assert.equal(video.playbackRate, 1.25);
});

test("an eligible skip is clicked, reported, and never repeated in one episode", () => {
  let clicks = 0;
  const messages = [];
  const button = createButton({ click: () => clicks++ });
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: button,
    sendMessage: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
  });

  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(clicks, 1);
  assert.deepEqual(messages, [{ type: "skip-action" }]);
  assert.equal(harness.controller.getState().episode.skipAttempted, true);
});

test("skip-first ordering restores an owned acceleration before clicking", () => {
  const observedRates = [];
  const { video, writes } = createVideo();
  const harness = createHarness({ video });

  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  harness.page.querySelector().querySelectorAll = () => [
    createButton({ click: () => observedRates.push(video.playbackRate) }),
  ];
  harness.controller.evaluate();

  assert.deepEqual(writes, [2, 1]);
  assert.deepEqual(observedRates, [1]);
});

test("skip waits for a transient restoration failure before clicking", () => {
  let playbackRate = 1;
  let failRestoreOnce = true;
  let clicks = 0;
  const messages = [];
  const video = {
    currentSrc: "https://www.youtube.com/ad-1",
    currentTime: 0,
    duration: 30,
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value) {
      if (value === 1 && failRestoreOnce) {
        failRestoreOnce = false;
        throw new Error("transient media failure");
      }
      playbackRate = value;
    },
  };
  const harness = createHarness({
    video,
    sendMessage: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
  });

  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  harness.page.querySelector().querySelectorAll = () => [
    createButton({
      click: () => {
        clicks += 1;
        assert.equal(video.playbackRate, 1);
      },
    }),
  ];

  harness.controller.evaluate();
  assert.equal(clicks, 0);
  assert.deepEqual(messages, []);
  assert.equal(harness.controller.getState().episode.appliedRate, 2);

  harness.controller.evaluate();
  assert.equal(clicks, 1);
  assert.deepEqual(messages, [{ type: "skip-action" }]);
  assert.equal(video.playbackRate, 1);
});

test("disabled, hidden, disconnected, and aria-disabled controls are ignored", () => {
  assert.equal(isEligibleSkipButton(createButton({ disabled: true })), false);
  assert.equal(isEligibleSkipButton(createButton({ hidden: true })), false);
  assert.equal(isEligibleSkipButton(createButton({ isConnected: false })), false);
  assert.equal(
    isEligibleSkipButton(
      createButton({ getAttribute: () => "true" }),
    ),
    false,
  );
  assert.equal(
    isEligibleSkipButton(createButton({ getClientRects: () => [] })),
    false,
  );
});

test("a failed click is contained and retried on the next observation", () => {
  let attempts = 0;
  const button = createButton({
    click: () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("detached");
      }
    },
  });
  const { video } = createVideo();
  const harness = createHarness({ video, skipButton: button });

  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(attempts, 2);
  assert.equal(harness.controller.getState().episode.skipAttempted, true);
});

test("a source change creates a new episode and allows another skip", () => {
  let clicks = 0;
  const button = createButton({ click: () => clicks++ });
  const { video } = createVideo();
  const harness = createHarness({ video, skipButton: button });

  harness.controller.evaluate();
  video.currentSrc = "https://www.youtube.com/ad-2";
  harness.controller.evaluate();
  assert.equal(clicks, 2);
});

test("an ad-pod source change preserves the pre-ad restoration baseline", () => {
  const { video, writes, setRateExternally } = createVideo({
    playbackRate: 1.5,
  });
  const harness = createHarness({ video, adActive: false });
  const player = harness.page.querySelector();

  harness.controller.evaluate();
  player.classList.contains = () => true;
  setRateExternally(1);
  harness.controller.evaluate();
  video.currentSrc = "https://www.youtube.com/ad-2";
  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  player.classList.contains = () => false;
  harness.controller.evaluate();

  assert.deepEqual(writes, [2, 1.5]);
  assert.equal(video.playbackRate, 1.5);
});

test("a transient restoration failure retains ownership and retries", () => {
  let playbackRate = 1;
  let failRestoreOnce = true;
  const writes = [];
  const video = {
    currentSrc: "https://www.youtube.com/ad-1",
    currentTime: 0,
    duration: 30,
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(value) {
      writes.push(value);
      if (value === 1 && failRestoreOnce) {
        failRestoreOnce = false;
        throw new Error("transient media failure");
      }
      playbackRate = value;
    },
  };
  const harness = createHarness({ video });
  const player = harness.page.querySelector();

  harness.controller.evaluate();
  harness.setTime(6_000);
  harness.controller.evaluate();
  player.classList.contains = () => false;
  harness.controller.evaluate();
  assert.equal(video.playbackRate, 2);
  assert.equal(harness.controller.getState().episode.appliedRate, 2);

  harness.controller.evaluate();
  assert.equal(video.playbackRate, 1);
  assert.equal(harness.controller.getState().episode, null);
  assert.deepEqual(writes, [2, 1, 1]);
});

test("controller start and stop own exactly one timer and restore once", () => {
  const { video, writes } = createVideo();
  let scheduled = 0;
  let cleared = 0;
  const controller = createController({
    documentApi: createPage(video),
    runtimeApi: { sendMessage() {} },
    now: () => 6_000,
    setTimeoutApi: () => {
      scheduled += 1;
      return scheduled;
    },
    clearTimeoutApi: () => {
      cleared += 1;
    },
  });

  assert.equal(controller.start(), true);
  assert.equal(controller.start(), false);
  assert.equal(scheduled, 1);
  assert.equal(controller.stop(), true);
  assert.equal(controller.stop(), false);
  assert.equal(cleared, 1);
  assert.deepEqual(writes, []);
});

test("bootstrap is idempotent and page lifecycle reuses one controller", () => {
  const listeners = new Map();
  const timers = [];
  const { video } = createVideo();
  const root = {
    Date: { now: () => 0 },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    chrome: { runtime: { sendMessage() {} } },
    clearTimeout() {},
    document: createPage(video, { adActive: false }),
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
  };

  const first = bootstrap(root);
  const second = bootstrap(root);
  assert.equal(first, second);
  assert.equal(root[INSTANCE_KEY], first);
  assert.equal(timers.length, 1);

  listeners.get("pagehide")();
  listeners.get("pageshow")();
  assert.equal(timers.length, 2);
  first.dispose();
  assert.equal(root[INSTANCE_KEY], undefined);
});
