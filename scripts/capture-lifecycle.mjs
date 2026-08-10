import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import gifenc from "gifenc";
import pngjs from "pngjs";
import { chromium } from "playwright";

import { decodeGifEvidence } from "./gif-evidence.mjs";
import {
  canonicalLifecycleEvidence,
  LIFECYCLE_SCENARIO,
  LIFECYCLE_STEP_KINDS,
  normalizeLifecycleEvidence,
} from "./lifecycle-evidence.mjs";
import {
  LIFECYCLE_FIXTURE_URLS,
  LIFECYCLE_PAGE_API,
  LIFECYCLE_SELECTORS,
  matchLifecycleFixtureUrl,
  renderLifecycleFixture,
} from "./lifecycle-fixture.mjs";
import {
  buildLifecycleFrameHtml,
  buildLifecycleMatrixHtml,
  buildLifecycleTimelineSvg,
  buildLifecycleTranscript,
  LIFECYCLE_RENDER_CONTRACT,
  lifecycleReceiptSha256,
} from "./lifecycle-render.mjs";

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;
const WAIT_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForValue(readValue, description, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!value && Date.now() < deadline) {
    await sleep(POLL_MS);
    value = await readValue();
  }
  if (!value) {
    throw new Error(`lifecycle capture timed out: ${description}`);
  }
  return value;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function describeFile(filePath) {
  const bytes = await readFile(filePath);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

async function decodedRgbaSha256(filePath, expectedWidth, expectedHeight) {
  const image = PNG.sync.read(await readFile(filePath));
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error("lifecycle PNG dimensions drifted");
  }
  return sha256Bytes(image.data);
}

async function waitForCounterChannels(popupPage, expectedCount) {
  await popupPage.waitForFunction(
    async (expected) => {
      try {
        const stored = await chrome.storage.local.get([
          "counterState",
          "adsSkipped",
        ]);
        const badgeText = await chrome.action.getBadgeText({});
        const state = stored.counterState;
        const stateKeys =
          state && typeof state === "object" && !Array.isArray(state)
            ? Object.keys(state).sort()
            : [];
        const ids = state?.recentActionIds;
        const exactState =
          JSON.stringify(stateKeys) ===
            JSON.stringify(["count", "recentActionIds", "schemaVersion"]) &&
          state.schemaVersion === 1 &&
          state.count === expected &&
          Array.isArray(ids) &&
          ids.length === expected &&
          new Set(ids).size === ids.length &&
          ids.every(
            (value) =>
              typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                value,
              ),
          );
        const legacyAbsent = !Object.prototype.hasOwnProperty.call(
          stored,
          "adsSkipped",
        );
        return (
          exactState &&
          legacyAbsent &&
          badgeText === String(expected) &&
          document.getElementById("adsSkippedCount")?.textContent ===
            String(expected)
        );
      } catch {
        return false;
      }
    },
    expectedCount,
    { timeout: WAIT_TIMEOUT_MS },
  );

  return popupPage.evaluate(async () => {
    const stored = await chrome.storage.local.get([
      "counterState",
      "adsSkipped",
    ]);
    return {
      badgeText: await chrome.action.getBadgeText({}),
      count: stored.counterState.count,
      legacyKeyPresent: Object.prototype.hasOwnProperty.call(
        stored,
        "adsSkipped",
      ),
      popupText: document.getElementById("adsSkippedCount").textContent,
      retainedActionCount: stored.counterState.recentActionIds.length,
    };
  });
}

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 336, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#adsSkippedCount").waitFor({ state: "visible" });
  return page;
}

async function waitForFixture(page) {
  await page.waitForFunction(
    (apiName) => {
      const api = globalThis[apiName];
      return api?.schemaVersion === 1 && api.snapshot().ready === true;
    },
    LIFECYCLE_PAGE_API,
    { timeout: WAIT_TIMEOUT_MS },
  );
}

async function fixtureSnapshot(page) {
  return page.evaluate((apiName) => globalThis[apiName].snapshot(), LIFECYCLE_PAGE_API);
}

async function waitForFixtureClick(page, bucket) {
  await page.waitForFunction(
    ({ apiName, name }) =>
      globalThis[apiName]?.snapshot().clickCounts[name] === 1,
    { apiName: LIFECYCLE_PAGE_API, name: bucket },
    { timeout: WAIT_TIMEOUT_MS },
  );
  return fixtureSnapshot(page);
}

async function matchingWorkerTargetCount(browserSession, workerUrl) {
  const { targetInfos } = await browserSession.send("Target.getTargets");
  return targetInfos.filter(
    (target) => target.type === "service_worker" && target.url === workerUrl,
  ).length;
}

async function waitForWorkerTargetCount(browserSession, workerUrl, expected) {
  await waitForValue(
    async () =>
      (await matchingWorkerTargetCount(browserSession, workerUrl)) === expected,
    `service-worker target count ${expected}`,
  );
  return expected;
}

function observeServiceWorkerVersions(session) {
  const versions = new Map();
  const events = [];
  session.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
    for (const update of updates) {
      const version = {
        ...versions.get(update.versionId),
        ...update,
      };
      versions.set(update.versionId, version);
      events.push({ ...version });
    }
  });
  return { events, versions };
}

function stableWorkerStatusHistory(observer, versionId, startIndex) {
  const statuses = observer.events
    .slice(startIndex)
    .filter((event) => event.versionId === versionId)
    .map((event) => event.runningStatus)
    .filter((status) => status === "running" || status === "stopped");
  return statuses.filter((status, index) => status !== statuses[index - 1]);
}

function restartCycleFromHistory(statuses) {
  return statuses.reduce(
    (cycles, status, index) =>
      cycles +
      (index > 0 && statuses[index - 1] === "stopped" && status === "running"
        ? 1
        : 0),
    0,
  );
}

function requireStableStatusHistory(actual, expected, boundary) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected service-worker transition before ${boundary}`);
  }
}

async function waitForWorkerStatus(observer, workerUrl, runningStatus) {
  return waitForValue(
    () =>
      [...observer.versions.values()].find(
        (version) =>
          version.scriptURL === workerUrl &&
          version.runningStatus === runningStatus,
      ),
    `service worker ${runningStatus}`,
  );
}

async function waitForExactWorkerStatus(observer, versionId, runningStatus) {
  return waitForValue(
    () => {
      const version = observer.versions.get(versionId);
      return version?.runningStatus === runningStatus ? version : null;
    },
    `selected service worker ${runningStatus}`,
  );
}

async function encodeLifecycleGif(framePaths, outputPath, contract) {
  if (
    framePaths.length !== contract.frameCount ||
    contract.delaysMs.length !== contract.frameCount
  ) {
    throw new Error("lifecycle GIF contract drifted");
  }
  const gif = GIFEncoder();
  for (const [index, framePath] of framePaths.entries()) {
    const frame = PNG.sync.read(await readFile(framePath));
    if (frame.width !== contract.width || frame.height !== contract.height) {
      throw new Error("lifecycle GIF frame dimensions drifted");
    }
    const palette = quantize(frame.data, 256);
    const indexed = applyPalette(frame.data, palette);
    gif.writeFrame(indexed, frame.width, frame.height, {
      delay: contract.delaysMs[index],
      dispose: 1,
      palette,
      repeat: 0,
    });
  }
  gif.finish();
  await writeFile(outputPath, Buffer.from(gif.bytes()));
}

async function renderLifecycleArtifacts({
  context,
  evidence,
  receiptSha256,
  assetDir,
  evidenceDir,
  artifactDir,
}) {
  const input = { evidence, receiptSha256 };
  const timelinePath = path.join(assetDir, "lifecycle-timeline.svg");
  const matrixPath = path.join(assetDir, "lifecycle-matrix.png");
  const gifPath = path.join(assetDir, "lifecycle-workflow.gif");
  const transcriptPath = path.join(evidenceDir, "lifecycle-evidence.txt");
  await writeFile(timelinePath, buildLifecycleTimelineSvg(input));
  await writeFile(transcriptPath, buildLifecycleTranscript(input));

  const matrixPage = await context.newPage();
  await matrixPage.setViewportSize(LIFECYCLE_RENDER_CONTRACT.matrix);
  await matrixPage.setContent(buildLifecycleMatrixHtml(input), {
    waitUntil: "load",
  });
  await matrixPage.screenshot({
    animations: "disabled",
    path: matrixPath,
  });
  await matrixPage.close();

  const frameDir = path.join(artifactDir, "lifecycle-frames");
  await rm(frameDir, { force: true, recursive: true });
  await mkdir(frameDir, { recursive: true });
  const framePage = await context.newPage();
  await framePage.setViewportSize({
    width: LIFECYCLE_RENDER_CONTRACT.animation.width,
    height: LIFECYCLE_RENDER_CONTRACT.animation.height,
  });
  const framePaths = [];
  for (
    let index = 0;
    index < LIFECYCLE_RENDER_CONTRACT.animation.frameCount;
    index += 1
  ) {
    await framePage.setContent(buildLifecycleFrameHtml(input, index), {
      waitUntil: "load",
    });
    const framePath = path.join(
      frameDir,
      `lifecycle-${String(index + 1).padStart(2, "0")}.png`,
    );
    await framePage.screenshot({ animations: "disabled", path: framePath });
    framePaths.push(framePath);
  }
  await framePage.close();
  await encodeLifecycleGif(
    framePaths,
    gifPath,
    LIFECYCLE_RENDER_CONTRACT.animation,
  );

  const decoded = decodeGifEvidence(await readFile(gifPath));
  return {
    matrixDecodedRgbaSha256: await decodedRgbaSha256(
      matrixPath,
      LIFECYCLE_RENDER_CONTRACT.matrix.width,
      LIFECYCLE_RENDER_CONTRACT.matrix.height,
    ),
    workflowGif: {
      delaysMs: decoded.frames.map((frame) => frame.delayMs),
      frameCount: decoded.frames.length,
      framePixelSha256: decoded.frames.map((frame) => frame.pixelSha256),
      height: decoded.height,
      width: decoded.width,
    },
  };
}

function assertRenderContract(contract) {
  assert.deepEqual(
    { width: contract.timeline.width, height: contract.timeline.height },
    LIFECYCLE_RENDER_CONTRACT.timeline,
  );
  assert.equal(contract.matrix.width, LIFECYCLE_RENDER_CONTRACT.matrix.width);
  assert.equal(contract.matrix.height, LIFECYCLE_RENDER_CONTRACT.matrix.height);
  assert.deepEqual(
    {
      width: contract.workflowGif.width,
      height: contract.workflowGif.height,
      frameCount: contract.workflowGif.frameCount,
      delaysMs: contract.workflowGif.delaysMs,
    },
    LIFECYCLE_RENDER_CONTRACT.animation,
  );
}

export async function captureLifecycleEvidence({
  root,
  assetDir,
  evidenceDir,
  artifactDir,
  lifecycleContract,
}) {
  assertRenderContract(lifecycleContract);
  const profileDir = path.join(artifactDir, "lifecycle-profile");
  await rm(profileDir, { force: true, recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
    ],
    channel: "chromium",
    headless: true,
  });

  const fulfillmentCounts = Object.fromEntries(
    Object.keys(LIFECYCLE_FIXTURE_URLS).map((role) => [role, 0]),
  );
  let unexpectedHttpRequests = 0;
  try {
    await context.route("https://**/*", async (route) => {
      const role = matchLifecycleFixtureUrl(route.request().url());
      if (role !== null) {
        fulfillmentCounts[role] += 1;
        await route.fulfill({
          body: renderLifecycleFixture(role),
          contentType: "text/html; charset=utf-8",
          status: 200,
        });
        return;
      }
      unexpectedHttpRequests += 1;
      await route.abort("blockedbyclient");
    });
    await context.route("http://**/*", async (route) => {
      unexpectedHttpRequests += 1;
      await route.abort("blockedbyclient");
    });

    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", {
        timeout: WAIT_TIMEOUT_MS,
      });
    }
    const workerUrl = worker.url();
    const parsedWorkerUrl = new URL(workerUrl);
    if (
      parsedWorkerUrl.protocol !== "chrome-extension:" ||
      parsedWorkerUrl.pathname !== "/background.js"
    ) {
      throw new Error("unexpected extension service-worker boundary");
    }
    const extensionId = parsedWorkerUrl.hostname;

    const controlPage = await context.newPage();
    const workerSession = await context.newCDPSession(controlPage);
    const browserSession = await context.browser().newBrowserCDPSession();
    const workerObserver = observeServiceWorkerVersions(workerSession);
    await workerSession.send("ServiceWorker.enable");
    const initialVersion = await waitForWorkerStatus(
      workerObserver,
      workerUrl,
      "running",
    );
    const initialRunningEventIndex = workerObserver.events.findIndex(
      (event) =>
        event.versionId === initialVersion.versionId &&
        event.runningStatus === "running",
    );
    if (initialRunningEventIndex < 0) {
      throw new Error("initial running worker observation is missing");
    }
    const initialTargetCount = await waitForWorkerTargetCount(
      browserSession,
      workerUrl,
      1,
    );

    let popupPage = await openPopup(context, extensionId);
    const freshChannels = await waitForCounterChannels(popupPage, 0);
    assert.deepEqual(freshChannels, {
      badgeText: "0",
      count: 0,
      legacyKeyPresent: false,
      popupText: "0",
      retainedActionCount: 0,
    });

    const primaryPage = await context.newPage();
    await primaryPage.goto(LIFECYCLE_FIXTURE_URLS.primary, {
      waitUntil: "domcontentloaded",
    });
    await waitForFixture(primaryPage);
    const documentHandle = await primaryPage.evaluateHandle(() => document);
    const initialSnapshot = await waitForFixtureClick(primaryPage, "initial");
    await waitForCounterChannels(popupPage, 1);

    await primaryPage.evaluate(
      (apiName) => globalThis[apiName].beginSpaLongAd(),
      LIFECYCLE_PAGE_API,
    );
    const sameDocument = await primaryPage.evaluate(
      (originalDocument) => document === originalDocument,
      documentHandle,
    );
    const spaVideoHandle = await primaryPage.evaluateHandle(
      (selector) => document.querySelector(selector),
      LIFECYCLE_SELECTORS.video,
    );
    const spaSource = await primaryPage.evaluate(
      (video) => video.currentSrc,
      spaVideoHandle,
    );
    await primaryPage.waitForFunction(
      (apiName) => globalThis[apiName].snapshot().playbackRate === 2,
      LIFECYCLE_PAGE_API,
      { timeout: WAIT_TIMEOUT_MS },
    );
    await primaryPage.evaluate(
      (apiName) => globalThis[apiName].releaseSpaSkip(),
      LIFECYCLE_PAGE_API,
    );
    const spaSnapshot = await waitForFixtureClick(primaryPage, "spa");
    await waitForCounterChannels(popupPage, 2);

    await primaryPage.evaluate(
      (apiName) => globalThis[apiName].rotateAdPodAndRelease(),
      LIFECYCLE_PAGE_API,
    );
    const sameVideoElement = await primaryPage.evaluate(
      ({ selector, video }) => document.querySelector(selector) === video,
      { selector: LIFECYCLE_SELECTORS.video, video: spaVideoHandle },
    );
    const sourceChanged = await primaryPage.evaluate(
      ({ source, video }) => Boolean(video.currentSrc) && video.currentSrc !== source,
      { source: spaSource, video: spaVideoHandle },
    );
    const adPodSnapshot = await waitForFixtureClick(primaryPage, "adPod");
    await waitForCounterChannels(popupPage, 3);
    await documentHandle.dispose();
    await spaVideoHandle.dispose();

    const barrierAPage = await context.newPage();
    const barrierBPage = await context.newPage();
    const wakePage = await context.newPage();
    for (const [page, url] of [
      [barrierAPage, LIFECYCLE_FIXTURE_URLS.barrierA],
      [barrierBPage, LIFECYCLE_FIXTURE_URLS.barrierB],
      [wakePage, LIFECYCLE_FIXTURE_URLS.wake],
    ]) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForFixture(page);
    }
    await Promise.all(
      [barrierAPage, barrierBPage].map((page) =>
        page.evaluate(
          (apiName) => globalThis[apiName].releaseGatedSkip(),
          LIFECYCLE_PAGE_API,
        ),
      ),
    );
    const [barrierASnapshot, barrierBSnapshot] = await Promise.all([
      waitForFixtureClick(barrierAPage, "gated"),
      waitForFixtureClick(barrierBPage, "gated"),
    ]);
    await waitForCounterChannels(popupPage, 5);

    await Promise.all([
      primaryPage.close(),
      barrierAPage.close(),
      barrierBPage.close(),
      popupPage.close(),
    ]);
    popupPage = null;

    const targetCountBeforeStop = await waitForWorkerTargetCount(
      browserSession,
      workerUrl,
      1,
    );
    const preStopStatuses = stableWorkerStatusHistory(
      workerObserver,
      initialVersion.versionId,
      initialRunningEventIndex,
    );
    requireStableStatusHistory(preStopStatuses, ["running"], "explicit stop");
    const preStopRestartCycle = restartCycleFromHistory(preStopStatuses);
    await workerSession.send("ServiceWorker.stopWorker", {
      versionId: initialVersion.versionId,
    });
    await waitForExactWorkerStatus(
      workerObserver,
      initialVersion.versionId,
      "stopped",
    );
    const stoppedTargetCount = await waitForWorkerTargetCount(
      browserSession,
      workerUrl,
      0,
    );
    const stoppedStatuses = stableWorkerStatusHistory(
      workerObserver,
      initialVersion.versionId,
      initialRunningEventIndex,
    );
    requireStableStatusHistory(
      stoppedStatuses,
      ["running", "stopped"],
      "gated wake release",
    );
    const stoppedRestartCycle = restartCycleFromHistory(stoppedStatuses);

    await wakePage.evaluate(
      (apiName) => globalThis[apiName].releaseGatedSkip(),
      LIFECYCLE_PAGE_API,
    );
    const wakeSnapshot = await waitForFixtureClick(wakePage, "gated");
    const wokenVersion = await waitForWorkerStatus(
      workerObserver,
      workerUrl,
      "running",
    );
    const wokenTargetCount = await waitForWorkerTargetCount(
      browserSession,
      workerUrl,
      1,
    );
    const wokenStatuses = stableWorkerStatusHistory(
      workerObserver,
      initialVersion.versionId,
      initialRunningEventIndex,
    );
    requireStableStatusHistory(
      wokenStatuses,
      ["running", "stopped", "running"],
      "final convergence",
    );
    const wokenRestartCycle = restartCycleFromHistory(wokenStatuses);
    popupPage = await openPopup(context, extensionId);
    const finalChannels = await waitForCounterChannels(popupPage, 6);
    assert.deepEqual(finalChannels, {
      badgeText: "6",
      count: 6,
      legacyKeyPresent: false,
      popupText: "6",
      retainedActionCount: 6,
    });

    const evidence = normalizeLifecycleEvidence({
      schemaVersion: 1,
      scenario: LIFECYCLE_SCENARIO,
      fixtureFulfillments: Object.values(fulfillmentCounts).reduce(
        (sum, value) => sum + value,
        0,
      ),
      unexpectedHttpRequests,
      steps: [
        {
          kind: "fresh_profile",
          count: freshChannels.count,
          restartCycle: preStopRestartCycle,
          runningStatus: initialVersion.runningStatus,
          activeTargetCount: initialTargetCount,
        },
        {
          kind: "initial_action",
          count: 1,
          clickCount: initialSnapshot.clickCounts.initial,
        },
        {
          kind: "spa_rate_restore",
          count: 2,
          clickCount: spaSnapshot.clickCounts.spa,
          sameDocument,
          acceleratedRate: 2,
          rateAtClick: spaSnapshot.rateAtClick.spa,
        },
        {
          kind: "ad_pod_rotation",
          count: 3,
          clickCount: adPodSnapshot.clickCounts.adPod,
          sameVideoElement,
          sourceChanged,
        },
        {
          kind: "two_tab_barrier",
          count: 5,
          countDelta: 2,
          clickCounts: [
            barrierASnapshot.clickCounts.gated,
            barrierBSnapshot.clickCounts.gated,
          ],
          restartCycle: preStopRestartCycle,
        },
        {
          kind: "worker_stopped",
          count: 5,
          restartCycle: stoppedRestartCycle,
          runningStatuses: stoppedStatuses,
          activeTargetCounts: [targetCountBeforeStop, stoppedTargetCount],
        },
        {
          kind: "worker_woken",
          count: finalChannels.count,
          clickCount: wakeSnapshot.clickCounts.gated,
          previousRestartCycle: stoppedRestartCycle,
          restartCycle: wokenRestartCycle,
          runningStatuses: wokenStatuses,
          activeTargetCounts: [
            targetCountBeforeStop,
            stoppedTargetCount,
            wokenTargetCount,
          ],
          sameRegistration:
            initialVersion.registrationId === wokenVersion.registrationId,
          sameVersion: initialVersion.versionId === wokenVersion.versionId,
        },
        { kind: "final_popup", count: finalChannels.count },
      ],
    });
    assert.deepEqual(fulfillmentCounts, {
      primary: 1,
      barrierA: 1,
      barrierB: 1,
      wake: 1,
    });

    const receiptBytes = canonicalLifecycleEvidence(evidence);
    const receiptSha256 = lifecycleReceiptSha256(evidence);
    if (
      receiptBytes.length !== lifecycleContract.receipt.bytes ||
      receiptSha256 !== lifecycleContract.receipt.sha256
    ) {
      throw new Error("canonical lifecycle receipt drifted");
    }
    const receiptPath = path.join(evidenceDir, "lifecycle-evidence.json");
    await writeFile(receiptPath, receiptBytes);

    const popupPath = path.join(assetDir, "popup-lifecycle-final.png");
    await popupPage.locator("body").screenshot({
      animations: "disabled",
      path: popupPath,
    });
    const popupDecodedRgbaSha256 = await decodedRgbaSha256(
      popupPath,
      lifecycleContract.popup.width,
      lifecycleContract.popup.height,
    );
    const rendered = await renderLifecycleArtifacts({
      context,
      evidence,
      receiptSha256,
      assetDir,
      evidenceDir,
      artifactDir,
    });
    if (
      unexpectedHttpRequests !== evidence.unexpectedHttpRequests ||
      JSON.stringify(fulfillmentCounts) !==
        JSON.stringify({ primary: 1, barrierA: 1, barrierB: 1, wake: 1 })
    ) {
      throw new Error("network or fixture boundary drifted during rendering");
    }
    const receipt = await describeFile(receiptPath);

    return {
      schemaVersion: 1,
      scenario: LIFECYCLE_SCENARIO,
      receipt: {
        path: "docs/evidence/lifecycle-evidence.json",
        ...receipt,
      },
      stepKinds: [...LIFECYCLE_STEP_KINDS],
      observationCount: evidence.steps.length,
      initialCount: evidence.steps[0].count,
      finalCount: evidence.steps.at(-1).count,
      fixtureFulfillments: evidence.fixtureFulfillments,
      unexpectedHttpRequests: evidence.unexpectedHttpRequests,
      renderedArtifacts: {
        "docs/evidence/lifecycle-evidence.txt": {
          kind: "plainTranscript",
          sourceReceiptSha256: receiptSha256,
        },
        "docs/assets/lifecycle-timeline.svg": {
          kind: "categoricalTimeline",
          width: lifecycleContract.timeline.width,
          height: lifecycleContract.timeline.height,
          sourceReceiptSha256: receiptSha256,
        },
        "docs/assets/lifecycle-matrix.png": {
          kind: "categoricalMatrix",
          width: lifecycleContract.matrix.width,
          height: lifecycleContract.matrix.height,
          decodedRgbaSha256: rendered.matrixDecodedRgbaSha256,
          sourceReceiptSha256: receiptSha256,
        },
        "docs/assets/lifecycle-workflow.gif": {
          kind: "categoricalReplay",
          ...rendered.workflowGif,
          sourceReceiptSha256: receiptSha256,
        },
      },
      coCapturedArtifacts: {
        "docs/assets/popup-lifecycle-final.png": {
          kind: "realExtensionPopupBody",
          width: lifecycleContract.popup.width,
          height: lifecycleContract.popup.height,
          observedText: finalChannels.popupText,
          decodedRgbaSha256: popupDecodedRgbaSha256,
          coCapturedWithReceiptSha256: receiptSha256,
        },
      },
      scope: {
        frameTimingRepresentsElapsedTime: false,
        workerStopBoundary: "quiescent",
        liveYouTubeAcceptance: false,
      },
    };
  } finally {
    await context.close();
  }
}
