export const LIFECYCLE_PAGE_API = "__YTAS_LIFECYCLE_FIXTURE_V1__";

export const LIFECYCLE_FIXTURE_URLS = Object.freeze({
  primary: "https://www.youtube.com/watch?v=ytas-lifecycle-primary",
  barrierA: "https://www.youtube.com/watch?v=ytas-lifecycle-barrier-a",
  barrierB: "https://www.youtube.com/watch?v=ytas-lifecycle-barrier-b",
  wake: "https://www.youtube.com/watch?v=ytas-lifecycle-wake",
});

export const LIFECYCLE_SELECTORS = Object.freeze({
  root: '[data-ytas-fixture="lifecycle-v1"]',
  player: ".html5-video-player",
  video: "video.html5-main-video",
  skip: "button.ytp-ad-skip-button-modern",
  status: "[data-ytas-status]",
});

const URL_TO_ROLE = new Map(
  Object.entries(LIFECYCLE_FIXTURE_URLS).map(([role, url]) => [url, role]),
);

function requireRole(role) {
  if (
    typeof role !== "string" ||
    !Object.hasOwn(LIFECYCLE_FIXTURE_URLS, role)
  ) {
    throw new TypeError("unknown lifecycle fixture role");
  }
  return role;
}

export function matchLifecycleFixtureUrl(url) {
  return typeof url === "string" ? URL_TO_ROLE.get(url) || null : null;
}

export function renderLifecycleFixture(role) {
  requireRole(role);
  const serializedRole = JSON.stringify(role);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>YouTube Ad Skipper lifecycle fixture</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23ef4444' d='M2 2h12v12H2z'/%3E%3C/svg%3E">
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; }
      body {
        display: grid;
        place-items: center;
        background: #090d16;
        color: #e2e8f0;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      [data-ytas-fixture="lifecycle-v1"] {
        width: min(760px, calc(100vw - 48px));
        padding: 32px;
        border: 1px solid #334155;
        border-radius: 20px;
        background: #111827;
      }
      .fixture-label {
        margin: 0 0 16px;
        color: #f87171;
        font: 800 13px/1.4 ui-monospace, monospace;
        letter-spacing: 1.4px;
      }
      .html5-video-player {
        position: relative;
        min-height: 260px;
        display: grid;
        place-items: center;
        overflow: hidden;
        border-radius: 14px;
        background: #020617;
      }
      video.html5-main-video {
        width: 100%;
        height: 260px;
      }
      button.ytp-ad-skip-button-modern {
        position: absolute;
        right: 24px;
        bottom: 24px;
        min-width: 150px;
        min-height: 48px;
        padding: 12px 18px;
        border: 1px solid #f8fafc;
        border-radius: 8px;
        background: rgb(15 23 42 / 92%);
        color: #f8fafc;
        cursor: pointer;
        font: 700 15px/1.2 ui-sans-serif, system-ui, sans-serif;
      }
      [data-ytas-status] {
        min-height: 24px;
        margin: 18px 0 0;
        color: #94a3b8;
        font: 600 14px/1.6 ui-monospace, monospace;
      }
    </style>
  </head>
  <body>
    <main data-ytas-fixture="lifecycle-v1">
      <p class="fixture-label">DETERMINISTIC OFFLINE LIFECYCLE FIXTURE</p>
      <section id="ytas-player" class="html5-video-player ad-showing" aria-label="Offline ad fixture"></section>
      <p data-ytas-status aria-live="polite"></p>
    </main>
    <script>
      "use strict";

      (() => {
        const API_NAME = "__YTAS_LIFECYCLE_FIXTURE_V1__";
        const role = ${serializedRole};
        const player = document.getElementById("ytas-player");
        const status = document.querySelector("[data-ytas-status]");
        const initialDocument = document;
        const mediaUrls = new WeakMap();
        const clickCounts = { initial: 0, spa: 0, adPod: 0, gated: 0 };
        const rateAtClick = { spa: null };
        const initialSeeds = {
          primary: 11,
          barrierA: 29,
          barrierB: 47,
          wake: 71,
        };
        let phase = role === "primary" ? "initial-loading" : "gated-loading";
        let video = null;
        let button = null;
        let sameVideoElement = false;
        let sourceChanged = false;

        function fail(message) {
          throw new Error("lifecycle fixture: " + message);
        }

        function requirePhase(method, expected) {
          if (phase !== expected) {
            fail(method + " requires phase " + expected);
          }
        }

        function requirePrimary(method) {
          if (role !== "primary") {
            fail(method + " is primary-only");
          }
        }

        function requireGatedRole(method) {
          if (role === "primary") {
            fail(method + " is unavailable on primary");
          }
        }

        function createPcmWav(seed, seconds = 40) {
          const sampleRate = 8000;
          const dataLength = sampleRate * seconds;
          const bytes = new Uint8Array(44 + dataLength);
          const view = new DataView(bytes.buffer);
          const writeAscii = (offset, value) => {
            for (let index = 0; index < value.length; index += 1) {
              bytes[offset + index] = value.charCodeAt(index);
            }
          };

          writeAscii(0, "RIFF");
          view.setUint32(4, 36 + dataLength, true);
          writeAscii(8, "WAVE");
          writeAscii(12, "fmt ");
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate, true);
          view.setUint16(32, 1, true);
          view.setUint16(34, 8, true);
          writeAscii(36, "data");
          view.setUint32(40, dataLength, true);
          for (let index = 0; index < dataLength; index += 1) {
            bytes[44 + index] = 124 + ((index + seed) % 9);
          }
          return new Blob([bytes], { type: "audio/wav" });
        }

        function createVideo() {
          const element = document.createElement("video");
          element.className = "html5-main-video";
          element.muted = true;
          element.playsInline = true;
          element.preload = "metadata";
          element.setAttribute("aria-label", "Generated PCM ad media");
          return element;
        }

        function loadEpisodeSource(element, seed) {
          const previousUrl = mediaUrls.get(element) || null;
          const nextUrl = URL.createObjectURL(createPcmWav(seed));
          mediaUrls.set(element, nextUrl);

          return new Promise((resolve, reject) => {
            const onLoaded = () => {
              element.removeEventListener("error", onError);
              if (previousUrl !== null) {
                URL.revokeObjectURL(previousUrl);
              }
              resolve();
            };
            const onError = () => {
              element.removeEventListener("loadedmetadata", onLoaded);
              URL.revokeObjectURL(nextUrl);
              mediaUrls.delete(element);
              reject(new Error("generated PCM WAV failed to load"));
            };
            element.addEventListener("loadedmetadata", onLoaded, { once: true });
            element.addEventListener("error", onError, { once: true });
            element.src = nextUrl;
            element.load();
          });
        }

        function releaseMedia(element) {
          const objectUrl = mediaUrls.get(element);
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            mediaUrls.delete(element);
          }
        }

        function setGated(element, gated) {
          element.hidden = gated;
          element.disabled = gated;
          if (gated) {
            element.setAttribute("aria-disabled", "true");
          } else {
            element.removeAttribute("aria-disabled");
          }
        }

        function updateStatus() {
          const total = Object.values(clickCounts).reduce(
            (sum, value) => sum + value,
            0,
          );
          status.textContent = role + " · " + phase + " · local clicks " + total;
        }

        function finishClick(kind, nextPhase) {
          if (!button || button.hidden || button.disabled) {
            return;
          }
          if (clickCounts[kind] !== 0) {
            return;
          }
          if (kind === "spa") {
            rateAtClick.spa = Number.isFinite(video.playbackRate)
              ? video.playbackRate
              : null;
          }
          clickCounts[kind] += 1;
          phase = nextPhase;
          setGated(button, true);
          updateStatus();
        }

        function createSkipButton(kind, gated) {
          const element = document.createElement("button");
          element.type = "button";
          element.className = "ytp-ad-skip-button-modern";
          element.textContent = "Skip fixture ad";
          setGated(element, gated);
          const nextPhase = {
            initial: "initial-clicked",
            spa: "spa-clicked",
            adPod: "ad-pod-clicked",
            gated: "gated-clicked",
          }[kind];
          element.addEventListener("click", () => finishClick(kind, nextPhase));
          return element;
        }

        function currentButtonEligible() {
          return Boolean(
            button &&
              button.isConnected &&
              !button.hidden &&
              !button.disabled &&
              button.getAttribute("aria-disabled") !== "true" &&
              button.getClientRects().length > 0,
          );
        }

        function snapshot() {
          return {
            schemaVersion: 1,
            role,
            phase,
            ready: true,
            playbackRate:
              video && Number.isFinite(video.playbackRate)
                ? video.playbackRate
                : null,
            buttonEligible: currentButtonEligible(),
            clickCounts: {
              initial: clickCounts.initial,
              spa: clickCounts.spa,
              adPod: clickCounts.adPod,
              gated: clickCounts.gated,
            },
            rateAtClick: { spa: rateAtClick.spa },
            sameDocument: document === initialDocument,
            sameVideoElement,
            sourceChanged,
          };
        }

        async function beginSpaLongAd() {
          requirePrimary("beginSpaLongAd");
          requirePhase("beginSpaLongAd", "initial-clicked");
          phase = "spa-loading";
          if (button) {
            button.remove();
            button = null;
          }
          history.pushState(
            { fixture: "lifecycle-v1" },
            "",
            "/watch?v=ytas-lifecycle-primary-spa",
          );
          const previousVideo = video;
          const nextVideo = createVideo();
          player.replaceChildren(nextVideo);
          video = nextVideo;
          await loadEpisodeSource(video, 101);
          releaseMedia(previousVideo);
          button = createSkipButton("spa", true);
          player.append(button);
          phase = "spa-gated";
          updateStatus();
          return snapshot();
        }

        function releaseSpaSkip() {
          requirePrimary("releaseSpaSkip");
          requirePhase("releaseSpaSkip", "spa-gated");
          phase = "spa-released";
          setGated(button, false);
          updateStatus();
          return snapshot();
        }

        async function rotateAdPodAndRelease() {
          requirePrimary("rotateAdPodAndRelease");
          requirePhase("rotateAdPodAndRelease", "spa-clicked");
          phase = "ad-pod-loading";
          button.remove();
          button = null;
          const retainedVideo = video;
          const previousSource = video.currentSrc;
          await loadEpisodeSource(video, 149);
          sameVideoElement = video === retainedVideo;
          sourceChanged =
            previousSource.length > 0 &&
            video.currentSrc.length > 0 &&
            video.currentSrc !== previousSource;
          if (!sameVideoElement || !sourceChanged) {
            fail("native ad-pod source rotation was not observed");
          }
          button = createSkipButton("adPod", false);
          player.append(button);
          phase = "ad-pod-released";
          updateStatus();
          return snapshot();
        }

        function releaseGatedSkip() {
          requireGatedRole("releaseGatedSkip");
          requirePhase("releaseGatedSkip", "gated");
          phase = "gated-released";
          setGated(button, false);
          updateStatus();
          return snapshot();
        }

        async function initialize() {
          video = createVideo();
          player.append(video);
          await loadEpisodeSource(video, initialSeeds[role]);
          if (role === "primary") {
            button = createSkipButton("initial", false);
            phase = "initial-ready";
          } else {
            button = createSkipButton("gated", true);
            phase = "gated";
          }
          player.append(button);
          updateStatus();
          window[API_NAME] = Object.freeze({
            schemaVersion: 1,
            role,
            snapshot,
            beginSpaLongAd,
            releaseSpaSkip,
            rotateAdPodAndRelease,
            releaseGatedSkip,
          });
        }

        void initialize();
      })();
    </script>
  </body>
</html>
`;
}
