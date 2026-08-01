"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACCELERATION_GRACE_MS,
  INSTANCE_KEY,
  MAX_PENDING_REPORTS,
  REPORT_RESPONSE_TIMEOUT_MS,
  REPORT_RETRY_BASE_MS,
  REPORT_RETRY_MAX_MS,
  bootstrap,
  choosePlaybackRate,
  createController,
  isEligibleSkipButton,
} = require("../content.js");

function actionId(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function settleReports() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  createActionId,
  video,
  adActive = true,
  skipButton = null,
  now = 0,
  sendMessage = (message) =>
    Promise.resolve({
      ok: true,
      actionId: message.actionId,
      count: 1,
      duplicate: false,
    }),
  setTimeoutApi = () => 1,
  clearTimeoutApi = () => {},
} = {}) {
  let time = now;
  let actionSequence = 0;
  const page = createPage(video, { adActive, skipButton });
  const controller = createController({
    createActionId:
      createActionId || (() => actionId((actionSequence += 1))),
    documentApi: page,
    runtimeApi: { sendMessage },
    now: () => time,
    setTimeoutApi,
    clearTimeoutApi,
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

test("page suspension pauses ad age until active time reaches the grace threshold", () => {
  const { video, writes } = createVideo();
  const harness = createHarness({ video });

  harness.controller.start();
  harness.setTime(3_000);
  harness.controller.evaluate();
  harness.controller.stop();

  harness.setTime(12_000);
  harness.controller.start();
  assert.deepEqual(
    writes,
    [],
    "nine hidden seconds must not trigger acceleration on pageshow",
  );

  harness.setTime(14_999);
  harness.controller.evaluate();
  assert.deepEqual(writes, []);

  harness.setTime(15_000);
  harness.controller.evaluate();
  assert.deepEqual(writes, [2], "six active seconds trigger acceleration");
  harness.controller.dispose();
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
      return Promise.resolve({
        ok: true,
        actionId: message.actionId,
        count: 1,
        duplicate: false,
      });
    },
  });

  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(clicks, 1);
  assert.deepEqual(messages, [
    { type: "skip-action", actionId: actionId(1) },
  ]);
  assert.equal(harness.controller.getState().episode.skipAttempted, true);
});

test("one action report backs off deterministically until an exact acknowledgement", async () => {
  let clicks = 0;
  let sendAttempts = 0;
  const messages = [];
  const responses = [
    () => {
      throw new Error("worker is stopped");
    },
    () => Promise.reject(new Error("worker restarted")),
    () => Promise.resolve({ ok: false }),
    () =>
      Promise.resolve({
        ok: true,
        actionId: actionId(999),
        count: 1,
        duplicate: false,
      }),
    (message) =>
      Promise.resolve({
        ok: true,
        actionId: message.actionId,
        count: 1,
        duplicate: true,
      }),
  ];
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: createButton({ click: () => clicks++ }),
    sendMessage: (message) => {
      messages.push(message);
      const response = responses[sendAttempts];
      sendAttempts += 1;
      return response(message);
    },
  });

  harness.controller.evaluate();
  assert.equal(clicks, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(harness.controller.getState().pendingReportCount, 1);

  harness.setTime(999);
  harness.controller.evaluate();
  assert.equal(sendAttempts, 1, "the first retry waits for one second");

  harness.setTime(1_000);
  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(sendAttempts, 2, "one action ID may have only one in-flight send");
  await settleReports();

  harness.setTime(2_999);
  harness.controller.evaluate();
  assert.equal(sendAttempts, 2, "the second failure backs off for two seconds");

  harness.setTime(3_000);
  harness.controller.evaluate();
  await settleReports();

  harness.setTime(6_999);
  harness.controller.evaluate();
  assert.equal(sendAttempts, 3, "the third failure backs off for four seconds");

  harness.setTime(7_000);
  harness.controller.evaluate();
  await settleReports();

  harness.setTime(14_999);
  harness.controller.evaluate();
  assert.equal(sendAttempts, 4, "the fourth failure backs off for eight seconds");

  harness.setTime(15_000);
  harness.controller.evaluate();
  await settleReports();

  assert.equal(sendAttempts, 5);
  assert.equal(clicks, 1);
  assert.equal(harness.controller.getState().pendingReportCount, 0);
  assert.deepEqual(
    messages,
    Array.from({ length: 5 }, () => ({
      type: "skip-action",
      actionId: actionId(1),
    })),
  );
  for (const message of messages) {
    assert.deepEqual(Object.keys(message).sort(), ["actionId", "type"]);
  }
});

test("report retry backoff grows exponentially and caps at thirty seconds", () => {
  const sendTimes = [];
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: createButton(),
    sendMessage: () => {
      sendTimes.push(currentTime);
      throw new Error("worker unavailable");
    },
  });
  let currentTime = 0;

  assert.equal(REPORT_RETRY_BASE_MS, 1_000);
  assert.equal(REPORT_RETRY_MAX_MS, 30_000);
  harness.controller.evaluate();

  const retryTimes = [1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000];
  for (const retryAt of retryTimes) {
    currentTime = retryAt - 1;
    harness.setTime(currentTime);
    harness.controller.evaluate();
    assert.equal(sendTimes.at(-1), retryTimes[sendTimes.length - 2] || 0);

    currentTime = retryAt;
    harness.setTime(currentTime);
    harness.controller.evaluate();
  }

  assert.deepEqual(sendTimes, [0, ...retryTimes]);
  assert.equal(harness.controller.getState().pendingReportCount, 1);
});

test("a timed-out attempt retries once and ignores its late completion", async () => {
  let clicks = 0;
  let sendAttempts = 0;
  let nextTimerId = 0;
  let resolveFirstAttempt;
  const timers = new Map();
  const firstAttempt = new Promise((resolve) => {
    resolveFirstAttempt = resolve;
  });
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: createButton({ click: () => clicks++ }),
    setTimeoutApi: (callback, delay) => {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeoutApi: (timerId) => timers.delete(timerId),
    sendMessage: (message) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return firstAttempt;
      }
      return Promise.resolve({
        ok: true,
        actionId: message.actionId,
        count: 1,
        duplicate: true,
      });
    },
  });

  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(sendAttempts, 1);
  assert.equal(clicks, 1);
  assert.equal(timers.size, 1);
  assert.equal(timers.get(1).delay, REPORT_RESPONSE_TIMEOUT_MS);

  const timeout = timers.get(1).callback;
  timers.delete(1);
  timeout();

  harness.setTime(999);
  harness.controller.evaluate();
  assert.equal(sendAttempts, 1);

  harness.setTime(1_000);
  harness.controller.evaluate();
  await settleReports();

  assert.equal(sendAttempts, 2);
  assert.equal(harness.controller.getState().pendingReportCount, 0);
  assert.equal(timers.size, 0);

  resolveFirstAttempt({
    ok: true,
    actionId: actionId(1),
    count: 1,
    duplicate: false,
  });
  await settleReports();
  harness.controller.evaluate();
  assert.equal(sendAttempts, 2);
  assert.equal(clicks, 1);
});

test("invalid or failing action ID generation degrades reporting without blocking skips", async () => {
  let clicks = 0;
  let generationAttempt = 0;
  const messages = [];
  const generated = [
    () => {
      throw new Error("secure random unavailable");
    },
    () => "00000000-0000-4000-8000-00000000000A",
    () => actionId(7),
  ];
  const { video } = createVideo();
  const harness = createHarness({
    createActionId: () => {
      const generate = generated[generationAttempt];
      generationAttempt += 1;
      return generate();
    },
    video,
    skipButton: createButton({ click: () => clicks++ }),
    sendMessage: (message) => {
      messages.push(message);
      return Promise.resolve({
        ok: true,
        actionId: message.actionId,
        count: 1,
        duplicate: false,
      });
    },
  });

  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(clicks, 1);
  assert.deepEqual(messages, []);
  assert.equal(harness.controller.getState().pendingReportCount, 0);
  assert.equal(harness.controller.getState().droppedReportCount, 1);
  assert.equal(harness.controller.getState().reportingDegraded, true);

  video.currentSrc = "https://www.youtube.com/ad-2";
  harness.controller.evaluate();
  assert.equal(clicks, 2);
  assert.deepEqual(messages, []);
  assert.equal(harness.controller.getState().droppedReportCount, 2);

  video.currentSrc = "https://www.youtube.com/ad-3";
  harness.controller.evaluate();
  await settleReports();
  assert.equal(clicks, 3);
  assert.deepEqual(messages, [
    { type: "skip-action", actionId: actionId(7) },
  ]);
  assert.equal(harness.controller.getState().pendingReportCount, 0);
  assert.equal(harness.controller.getState().droppedReportCount, 2);
  assert.equal(harness.controller.getState().reportingDegraded, true);
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
      return Promise.resolve({
        ok: true,
        actionId: message.actionId,
        count: 1,
        duplicate: false,
      });
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
  assert.deepEqual(messages, [
    { type: "skip-action", actionId: actionId(1) },
  ]);
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

test("source rotation keeps the first report while tracking a second click", async () => {
  let clicks = 0;
  const messages = [];
  const pendingResponses = [];
  const button = createButton({ click: () => clicks++ });
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: button,
    sendMessage: (message) => {
      messages.push(message);
      return new Promise((resolve) => pendingResponses.push({ message, resolve }));
    },
  });

  harness.controller.evaluate();
  video.currentSrc = "https://www.youtube.com/ad-2";
  harness.controller.evaluate();

  assert.equal(clicks, 2);
  assert.deepEqual(messages, [
    { type: "skip-action", actionId: actionId(1) },
    { type: "skip-action", actionId: actionId(2) },
  ]);
  assert.equal(harness.controller.getState().pendingReportCount, 2);

  for (const [index, pending] of pendingResponses.entries()) {
    pending.resolve({
      ok: true,
      actionId: pending.message.actionId,
      count: index + 1,
      duplicate: false,
    });
  }
  await settleReports();

  assert.equal(harness.controller.getState().pendingReportCount, 0);
  harness.controller.evaluate();
  assert.equal(clicks, 2);
  assert.equal(messages.length, 2);
});

test("a full pending outbox drops only reporting and still clicks once", () => {
  let clicks = 0;
  const messages = [];
  const button = createButton({ click: () => clicks++ });
  const { video } = createVideo();
  const harness = createHarness({
    video,
    skipButton: button,
    sendMessage: (message) => {
      messages.push(message);
      return new Promise(() => {});
    },
  });

  for (let index = 0; index < MAX_PENDING_REPORTS; index += 1) {
    video.currentSrc = `https://www.youtube.com/ad-${index}`;
    harness.controller.evaluate();
  }
  assert.equal(clicks, MAX_PENDING_REPORTS);
  assert.equal(messages.length, MAX_PENDING_REPORTS);
  assert.equal(
    harness.controller.getState().pendingReportCount,
    MAX_PENDING_REPORTS,
  );
  assert.equal(harness.controller.getState().reportingDegraded, false);

  video.currentSrc = "https://www.youtube.com/ad-overflow";
  harness.controller.evaluate();
  harness.controller.evaluate();
  assert.equal(clicks, MAX_PENDING_REPORTS + 1);
  assert.equal(messages.length, MAX_PENDING_REPORTS);
  assert.equal(
    harness.controller.getState().pendingReportCount,
    MAX_PENDING_REPORTS,
  );
  assert.equal(harness.controller.getState().droppedReportCount, 1);
  assert.equal(harness.controller.getState().reportingDegraded, true);
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

test("controller dispose invalidates all timers and permanently clears state", async () => {
  let clicks = 0;
  let nextTimerId = 0;
  let resolveReport;
  const timers = new Map();
  const { video } = createVideo();
  const controller = createController({
    createActionId: () => actionId(1),
    documentApi: createPage(video, {
      skipButton: createButton({ click: () => clicks++ }),
    }),
    runtimeApi: {
      sendMessage: () =>
        new Promise((resolve) => {
          resolveReport = resolve;
        }),
    },
    now: () => 0,
    setTimeoutApi: (callback, delay) => {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeoutApi: (timerId) => timers.delete(timerId),
  });

  assert.equal(controller.start(), true);
  assert.equal(clicks, 1);
  assert.equal(controller.getState().pendingReportCount, 1);
  assert.notEqual(controller.getState().episode, null);
  assert.equal(timers.size, 2);

  assert.equal(controller.dispose(), true);
  assert.deepEqual(
    {
      disposed: controller.getState().disposed,
      episode: controller.getState().episode,
      pending: controller.getState().pendingReportCount,
      running: controller.getState().running,
      timers: timers.size,
    },
    { disposed: true, episode: null, pending: 0, running: false, timers: 0 },
  );

  resolveReport({
    ok: true,
    actionId: actionId(1),
    count: 1,
    duplicate: false,
  });
  await settleReports();
  controller.evaluate();
  assert.equal(controller.getState().pendingReportCount, 0);
  assert.equal(clicks, 1);
  assert.equal(controller.start(), false);
  assert.equal(controller.stop(), false);
  assert.equal(controller.dispose(), false);
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
    crypto: { randomUUID: () => actionId(1) },
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

test("pagehide and pageshow retain one pending report without another click", async () => {
  let clicks = 0;
  let sendAttempts = 0;
  let nextTimerId = 0;
  let resolveFirstAttempt;
  const listeners = new Map();
  const messages = [];
  const timers = new Map();
  const { video } = createVideo();
  const root = {
    Date: { now: () => 0 },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          sendAttempts += 1;
          if (sendAttempts === 1) {
            return new Promise((resolve) => {
              resolveFirstAttempt = resolve;
            });
          }
          return Promise.resolve({
            ok: true,
            actionId: message.actionId,
            count: 1,
            duplicate: true,
          });
        },
      },
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    crypto: { randomUUID: () => actionId(1) },
    document: createPage(video, {
      skipButton: createButton({ click: () => clicks++ }),
    }),
    setTimeout(callback, delay) {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
  };

  const instance = bootstrap(root);
  assert.equal(clicks, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(instance.controller.getState().pendingReportCount, 1);
  assert.equal(timers.size, 2, "poll and response-timeout timers are owned");

  listeners.get("pagehide")();
  assert.equal(instance.controller.getState().running, false);
  assert.equal(timers.size, 0, "pagehide clears poll and response timeouts");

  resolveFirstAttempt({
    ok: true,
    actionId: actionId(1),
    count: 1,
    duplicate: false,
  });
  await settleReports();
  assert.equal(
    instance.controller.getState().pendingReportCount,
    1,
    "the invalidated first completion cannot consume the retained report",
  );

  listeners.get("pageshow")();
  await settleReports();

  assert.equal(clicks, 1);
  assert.equal(sendAttempts, 2);
  assert.deepEqual(messages, [
    { type: "skip-action", actionId: actionId(1) },
    { type: "skip-action", actionId: actionId(1) },
  ]);
  assert.equal(instance.controller.getState().pendingReportCount, 0);
  instance.dispose();
  assert.equal(timers.size, 0);
});
