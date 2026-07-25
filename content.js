(function exposeContent(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  api.bootstrap(root);
})(typeof globalThis === "object" ? globalThis : this, function createContentApi() {
  "use strict";

  const INSTANCE_KEY = "__YTAS_CONTROLLER_V2__";
  const MESSAGE_TYPE = "skip-action";
  const PLAYER_SELECTOR = ".html5-video-player";
  const VIDEO_SELECTOR = "video.html5-main-video";
  const SKIP_SELECTOR = [
    "button.ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    "button.ytp-skip-ad-button",
  ].join(",");
  const POLL_INTERVAL_MS = 500;
  const ACCELERATION_GRACE_MS = 6_000;
  const CONSERVATIVE_REMAINDER_SECONDS = 8;
  const MAX_EXTENSION_RATE = 2;
  const RATE_EPSILON = 1e-6;

  function isFinitePositive(value) {
    return Number.isFinite(value) && value > 0;
  }

  function ratesEqual(left, right) {
    return (
      Number.isFinite(left) &&
      Number.isFinite(right) &&
      Math.abs(left - right) <= RATE_EPSILON
    );
  }

  function choosePlaybackRate({
    originalRate,
    duration,
    currentTime,
    adAgeMs,
  }) {
    const safeOriginalRate = isFinitePositive(originalRate) ? originalRate : 1;

    if (
      !Number.isFinite(adAgeMs) ||
      adAgeMs < ACCELERATION_GRACE_MS ||
      !Number.isFinite(duration) ||
      !Number.isFinite(currentTime)
    ) {
      return safeOriginalRate;
    }

    const remaining = duration - currentTime;
    if (
      remaining <= CONSERVATIVE_REMAINDER_SECONDS ||
      safeOriginalRate >= MAX_EXTENSION_RATE
    ) {
      return safeOriginalRate;
    }

    return MAX_EXTENSION_RATE;
  }

  function isEligibleSkipButton(button) {
    if (
      !button ||
      typeof button.click !== "function" ||
      button.isConnected === false ||
      button.hidden === true ||
      button.disabled === true
    ) {
      return false;
    }

    if (
      typeof button.getAttribute === "function" &&
      button.getAttribute("aria-disabled") === "true"
    ) {
      return false;
    }

    if (
      typeof button.getClientRects === "function" &&
      button.getClientRects().length === 0
    ) {
      return false;
    }

    return true;
  }

  function readPageState(documentApi) {
    const player = documentApi.querySelector(PLAYER_SELECTOR);
    if (!player) {
      return { adActive: false, player: null, skipButton: null, video: null };
    }

    const video = player.querySelector(VIDEO_SELECTOR);
    const adActive =
      player.classList &&
      typeof player.classList.contains === "function" &&
      player.classList.contains("ad-showing");
    let skipButton = null;

    if (adActive && typeof player.querySelectorAll === "function") {
      skipButton =
        Array.from(player.querySelectorAll(SKIP_SELECTOR)).find(
          isEligibleSkipButton,
        ) || null;
    }

    return { adActive: Boolean(adActive), player, skipButton, video };
  }

  function createController({
    documentApi,
    runtimeApi,
    now = () => Date.now(),
    setTimeoutApi = setTimeout,
    clearTimeoutApi = clearTimeout,
    pollIntervalMs = POLL_INTERVAL_MS,
  }) {
    let running = false;
    let timerId = null;
    let episode = null;
    let normalVideo = null;
    let normalRate = 1;

    function readRate(video) {
      try {
        return isFinitePositive(video.playbackRate) ? video.playbackRate : 1;
      } catch {
        return 1;
      }
    }

    function writeRate(video, rate) {
      try {
        video.playbackRate = rate;
        return readRate(video);
      } catch {
        return null;
      }
    }

    function sourceKey(video) {
      try {
        return video.currentSrc || video.src || "";
      } catch {
        return "";
      }
    }

    function currentTime(video) {
      try {
        return Number.isFinite(video.currentTime) ? video.currentTime : null;
      } catch {
        return null;
      }
    }

    function restoreOwnedRate() {
      if (!episode || episode.appliedRate === null || episode.userOverride) {
        return true;
      }

      const currentRate = readRate(episode.video);
      if (!ratesEqual(currentRate, episode.appliedRate)) {
        episode.userOverride = true;
        episode.appliedRate = null;
        return true;
      }

      const restored = writeRate(episode.video, episode.restoreRate);
      if (restored === null) {
        return false;
      }
      if (!ratesEqual(restored, episode.restoreRate)) {
        episode.appliedRate = restored;
        return false;
      }

      episode.appliedRate = null;
      return true;
    }

    function leaveEpisode({ refreshNormalRate = true } = {}) {
      if (!episode) {
        return true;
      }

      const video = episode.video;
      if (!restoreOwnedRate()) {
        return false;
      }
      if (refreshNormalRate) {
        normalVideo = video;
        normalRate = readRate(video);
      }
      episode = null;
      return true;
    }

    function enterEpisode(video, carriedRestoreRate = null) {
      const capturedRate =
        carriedRestoreRate ??
        (normalVideo === video ? normalRate : readRate(video));
      episode = {
        video,
        restoreRate: isFinitePositive(capturedRate) ? capturedRate : 1,
        appliedRate: null,
        userOverride: false,
        startedAt: now(),
        sourceKey: sourceKey(video),
        lastCurrentTime: currentTime(video),
        skipAttempted: false,
      };
    }

    function rotateEpisode(video) {
      const previousEpisode = episode;
      if (!previousEpisode) {
        enterEpisode(video);
        return true;
      }

      if (!restoreOwnedRate()) {
        return false;
      }

      const carriedRestoreRate = previousEpisode.userOverride
        ? readRate(previousEpisode.video)
        : previousEpisode.restoreRate;
      episode = null;
      enterEpisode(video, carriedRestoreRate);
      return true;
    }

    function isNewEpisode(video) {
      if (!episode || episode.video !== video) {
        return true;
      }

      const nextSourceKey = sourceKey(video);
      if (
        episode.sourceKey &&
        nextSourceKey &&
        episode.sourceKey !== nextSourceKey
      ) {
        return true;
      }

      const nextCurrentTime = currentTime(video);
      return (
        episode.lastCurrentTime !== null &&
        nextCurrentTime !== null &&
        nextCurrentTime < episode.lastCurrentTime - 1
      );
    }

    function sendSkipAction() {
      try {
        const result = runtimeApi.sendMessage({ type: MESSAGE_TYPE });
        if (result && typeof result.catch === "function") {
          result.catch(() => undefined);
        }
      } catch {
        // A sleeping/reloading service worker must not stop page observation.
      }
    }

    function requestSkip(button) {
      if (!episode || episode.skipAttempted || !isEligibleSkipButton(button)) {
        return false;
      }

      if (!restoreOwnedRate()) {
        return false;
      }

      try {
        button.click();
      } catch {
        return false;
      }

      episode.skipAttempted = true;
      sendSkipAction();
      return true;
    }

    function applyPolicy(video) {
      if (!episode || episode.skipAttempted || episode.userOverride) {
        return;
      }

      if (
        episode.appliedRate !== null &&
        !ratesEqual(readRate(video), episode.appliedRate)
      ) {
        episode.userOverride = true;
        episode.appliedRate = null;
        return;
      }

      const targetRate = choosePlaybackRate({
        originalRate: episode.restoreRate,
        duration: video.duration,
        currentTime: video.currentTime,
        adAgeMs: now() - episode.startedAt,
      });

      if (ratesEqual(targetRate, episode.restoreRate)) {
        restoreOwnedRate();
        return;
      }

      if (
        episode.appliedRate !== null &&
        ratesEqual(episode.appliedRate, targetRate)
      ) {
        return;
      }

      const appliedRate = writeRate(video, targetRate);
      if (appliedRate !== null) {
        episode.appliedRate = appliedRate;
      }
    }

    function evaluate() {
      const pageState = readPageState(documentApi);

      if (!pageState.adActive || !pageState.video) {
        if (!leaveEpisode()) {
          return;
        }
        if (pageState.video) {
          normalVideo = pageState.video;
          normalRate = readRate(pageState.video);
        }
        return;
      }

      if (isNewEpisode(pageState.video)) {
        if (!rotateEpisode(pageState.video)) {
          return;
        }
      }

      episode.sourceKey = sourceKey(pageState.video);
      episode.lastCurrentTime = currentTime(pageState.video);

      if (requestSkip(pageState.skipButton)) {
        return;
      }

      applyPolicy(pageState.video);
    }

    function scheduleNext() {
      if (!running) {
        return;
      }
      timerId = setTimeoutApi(tick, pollIntervalMs);
    }

    function tick() {
      timerId = null;
      if (!running) {
        return;
      }

      try {
        evaluate();
      } catch {
        // YouTube owns this DOM. A transient query failure should be retried.
      } finally {
        scheduleNext();
      }
    }

    function start() {
      if (running) {
        return false;
      }
      running = true;
      tick();
      return true;
    }

    function stop() {
      if (!running && !episode) {
        return false;
      }
      running = false;
      if (timerId !== null) {
        clearTimeoutApi(timerId);
        timerId = null;
      }
      leaveEpisode();
      return true;
    }

    return {
      evaluate,
      getState: () => ({
        episode: episode
          ? {
              appliedRate: episode.appliedRate,
              restoreRate: episode.restoreRate,
              skipAttempted: episode.skipAttempted,
              userOverride: episode.userOverride,
            }
          : null,
        running,
      }),
      start,
      stop,
    };
  }

  function bootstrap(root) {
    if (root[INSTANCE_KEY]) {
      return root[INSTANCE_KEY];
    }

    const controller = createController({
      documentApi: root.document,
      runtimeApi: root.chrome.runtime,
      now: () => root.Date.now(),
      setTimeoutApi: root.setTimeout.bind(root),
      clearTimeoutApi: root.clearTimeout.bind(root),
    });

    const onPageHide = () => controller.stop();
    const onPageShow = () => controller.start();
    root.addEventListener("pagehide", onPageHide);
    root.addEventListener("pageshow", onPageShow);

    const instance = {
      controller,
      dispose() {
        controller.stop();
        root.removeEventListener("pagehide", onPageHide);
        root.removeEventListener("pageshow", onPageShow);
        if (root[INSTANCE_KEY] === instance) {
          delete root[INSTANCE_KEY];
        }
      },
    };

    root[INSTANCE_KEY] = instance;
    controller.start();
    return instance;
  }

  return {
    ACCELERATION_GRACE_MS,
    CONSERVATIVE_REMAINDER_SECONDS,
    INSTANCE_KEY,
    MAX_EXTENSION_RATE,
    MESSAGE_TYPE,
    POLL_INTERVAL_MS,
    SKIP_SELECTOR,
    bootstrap,
    choosePlaybackRate,
    createController,
    isEligibleSkipButton,
    ratesEqual,
    readPageState,
  };
});
