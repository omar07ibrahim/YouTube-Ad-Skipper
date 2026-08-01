"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const lifecycleEvidence = import("../scripts/lifecycle-evidence.mjs");
const lifecycleRender = import("../scripts/lifecycle-render.mjs");

function validEvidence() {
  return {
    schemaVersion: 1,
    scenario: "offline-mv3-lifecycle-v1",
    fixtureFulfillments: 4,
    unexpectedHttpRequests: 0,
    steps: [
      {
        kind: "fresh_profile",
        count: 0,
        restartCycle: 0,
        runningStatus: "running",
        activeTargetCount: 1,
      },
      { kind: "initial_action", count: 1, clickCount: 1 },
      {
        kind: "spa_rate_restore",
        count: 2,
        clickCount: 1,
        sameDocument: true,
        acceleratedRate: 2,
        rateAtClick: 1,
      },
      {
        kind: "ad_pod_rotation",
        count: 3,
        clickCount: 1,
        sameVideoElement: true,
        sourceChanged: true,
      },
      {
        kind: "two_tab_barrier",
        count: 5,
        countDelta: 2,
        clickCounts: [1, 1],
        restartCycle: 0,
      },
      {
        kind: "worker_stopped",
        count: 5,
        restartCycle: 0,
        runningStatuses: ["running", "stopped"],
        activeTargetCounts: [1, 0],
      },
      {
        kind: "worker_woken",
        count: 6,
        clickCount: 1,
        previousRestartCycle: 0,
        restartCycle: 1,
        runningStatuses: ["running", "stopped", "running"],
        activeTargetCounts: [1, 0, 1],
        sameRegistration: true,
        sameVersion: true,
      },
      { kind: "final_popup", count: 6 },
    ],
  };
}

async function validInput() {
  const { canonicalLifecycleEvidence } = await lifecycleEvidence;
  const evidence = validEvidence();
  return {
    evidence,
    receiptSha256: createHash("sha256")
      .update(canonicalLifecycleEvidence(evidence))
      .digest("hex"),
  };
}

test("render contract fixes dimensions, labels, frame timing, and claims", async () => {
  const { LIFECYCLE_RENDER_CONTRACT } = await lifecycleRender;

  assert.deepEqual(LIFECYCLE_RENDER_CONTRACT.timeline, {
    width: 1440,
    height: 720,
  });
  assert.deepEqual(LIFECYCLE_RENDER_CONTRACT.matrix, {
    width: 1440,
    height: 960,
    columns: ["Phase", "Counter", "Categorical observation", "Scope"],
  });
  assert.deepEqual(LIFECYCLE_RENDER_CONTRACT.animation, {
    width: 960,
    height: 540,
    frameCount: 8,
    delaysMs: Array(8).fill(1800),
  });
  assert.deepEqual(
    LIFECYCLE_RENDER_CONTRACT.phases.map((phase) => phase.kind),
    validEvidence().steps.map((step) => step.kind),
  );
  assert.equal(Object.isFrozen(LIFECYCLE_RENDER_CONTRACT), true);
  assert.equal(Object.isFrozen(LIFECYCLE_RENDER_CONTRACT.phases), true);
  assert.equal(Object.isFrozen(LIFECYCLE_RENDER_CONTRACT.phases[0]), true);
  assert.equal(Object.isFrozen(LIFECYCLE_RENDER_CONTRACT.animation.delaysMs), true);
  assert.throws(
    () => LIFECYCLE_RENDER_CONTRACT.phases.push({}),
    /not extensible|read only|object is not extensible/i,
  );
});

test("render model validates the receipt and returns detached immutable data", async () => {
  const {
    buildLifecycleRenderModel,
    lifecycleReceiptSha256,
  } = await lifecycleRender;
  const input = await validInput();
  const model = buildLifecycleRenderModel(input);

  assert.equal(lifecycleReceiptSha256(input.evidence), input.receiptSha256);
  assert.equal(model.receiptSha256, input.receiptSha256);
  assert.deepEqual(
    model.frames.map(({ ordinal, kind, count }) => ({ ordinal, kind, count })),
    [
      { ordinal: 1, kind: "fresh_profile", count: 0 },
      { ordinal: 2, kind: "initial_action", count: 1 },
      { ordinal: 3, kind: "spa_rate_restore", count: 2 },
      { ordinal: 4, kind: "ad_pod_rotation", count: 3 },
      { ordinal: 5, kind: "two_tab_barrier", count: 5 },
      { ordinal: 6, kind: "worker_stopped", count: 5 },
      { ordinal: 7, kind: "worker_woken", count: 6 },
      { ordinal: 8, kind: "final_popup", count: 6 },
    ],
  );
  input.evidence.steps[4].clickCounts[0] = 99;
  assert.deepEqual(model.frames[4].facts, [
    "count 5 · delta 2",
    "tab clicks [1, 1]",
  ]);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.frames), true);
  assert.equal(Object.isFrozen(model.frames[4].facts), true);
  assert.throws(
    () => model.frames[0].facts.push("drift"),
    /not extensible|read only|object is not extensible/i,
  );
});

test("plain transcript bytes are exact and bind every row to the receipt", async () => {
  const { buildLifecycleTranscript } = await lifecycleRender;
  const input = await validInput();
  const transcript = buildLifecycleTranscript(input);
  const expected = [
    "YouTube Ad Skipper — offline MV3 lifecycle receipt",
    `Receipt SHA-256: ${input.receiptSha256}`,
    "",
    "01  Fresh profile          count=0   worker running · targets 1",
    "02  Initial action         count=1   1 observed click",
    "03  Same-document SPA      count=2   same document · 2× → 1×",
    "04  Ad-pod rotation        count=3   same video · source changed",
    "05  Two-tab barrier        count=5   delta 2 · tab clicks [1, 1]",
    "06  Worker stopped         count=5   running → stopped · targets 1 → 0",
    "07  Worker woken           count=6   stopped → running · targets 0 → 1",
    "08  Final popup            count=6   popup count 6",
    "",
    "Classification: categorical observations; sequence positions are not elapsed-time measurements.",
    "Scope: offline fixture evidence; live YouTube acceptance is not claimed.",
    "",
  ].join("\n");

  assert.ok(Buffer.isBuffer(transcript));
  assert.deepEqual(transcript, Buffer.from(expected, "utf8"));
  assert.equal(transcript.at(-1), 0x0a);
  assert.equal(transcript.toString("utf8").match(/[0-9a-f]{64}/g).length, 1);
  assert.equal(transcript.includes(Buffer.from("\u001b", "utf8")), false);
});

test("timeline SVG is exact-size accessible categorical evidence", async () => {
  const { buildLifecycleTimelineSvg } = await lifecycleRender;
  const input = await validInput();
  const first = buildLifecycleTimelineSvg(input);
  const second = buildLifecycleTimelineSvg(input);

  assert.equal(first, second);
  assert.match(first, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /);
  assert.match(first, /width="1440" height="720"/);
  assert.match(first, /role="img"/);
  assert.match(
    first,
    /aria-labelledby="lifecycle-title lifecycle-description"/,
  );
  assert.match(first, /<title id="lifecycle-title">[^<]+<\/title>/);
  assert.match(first, /<desc id="lifecycle-description">[^<]+<\/desc>/);
  assert.match(first, /CATEGORICAL OBSERVATIONS · NOT ELAPSED TIME/);
  assert.match(first, /OFFLINE FIXTURE · NOT LIVE YOUTUBE ACCEPTANCE/);
  assert.equal(first.split(input.receiptSha256).length - 1, 2);
  assert.equal((first.match(/aria-label="Step /g) || []).length, 8);
  assert.equal((first.match(/class="count">COUNT /g) || []).length, 8);
  assert.equal(first.endsWith("\n"), true);
});

test("matrix HTML exposes all receipt-backed rows at 1440 by 960", async () => {
  const { buildLifecycleMatrixHtml } = await lifecycleRender;
  const input = await validInput();
  const html = buildLifecycleMatrixHtml(input);

  assert.equal(html, buildLifecycleMatrixHtml(input));
  assert.match(html, /html, body \{ width: 1440px; height: 960px;/);
  assert.match(html, /Categorical observation/);
  assert.match(html, /CATEGORICAL OBSERVATIONS · NOT ELAPSED TIME/);
  assert.match(html, /OFFLINE FIXTURE · NOT LIVE YOUTUBE ACCEPTANCE/);
  assert.match(html, /Sequence order is evidence of transition order only; it is not a timing scale\./);
  assert.equal(html.split(input.receiptSha256).length - 1, 1);
  assert.equal((html.match(/<th scope="row">/g) || []).length, 8);
  assert.match(html, /same registration\/version/);
  assert.match(html, /last committed before stop/);
  assert.doesNotMatch(html, /counter unchanged/);
  assert.doesNotMatch(html, /targetId|versionId|registrationId/);
});

test("eight GIF frame documents are immutable categorical snapshots", async () => {
  const {
    buildLifecycleFrameHtml,
    buildLifecycleRenderModel,
    LIFECYCLE_RENDER_CONTRACT,
  } = await lifecycleRender;
  const input = await validInput();
  const model = buildLifecycleRenderModel(input);
  const documents = model.frames.map((frame) =>
    buildLifecycleFrameHtml(input, frame.index),
  );

  assert.equal(documents.length, 8);
  for (const [index, html] of documents.entries()) {
    assert.match(html, /html, body \{ width: 960px; height: 540px;/);
    assert.match(html, /CATEGORICAL OBSERVATIONS · NOT ELAPSED TIME/);
    assert.match(html, /OFFLINE FIXTURE · NOT LIVE YOUTUBE ACCEPTANCE/);
    assert.match(html, /no elapsed-time claim · no live-site claim/);
    assert.match(html, new RegExp(`STEP ${index + 1} / 8`));
    assert.match(html, new RegExp(`OBSERVED COUNT<\\/span><strong>${model.frames[index].count}`));
    assert.equal(html.split(input.receiptSha256).length - 1, 1);
    assert.equal(html, buildLifecycleFrameHtml(input, index));
  }
  assert.deepEqual(
    LIFECYCLE_RENDER_CONTRACT.animation.delaysMs,
    documents.map(() => 1800),
  );
});

test("renderer rejects key, hash, evidence, and frame-index drift", async () => {
  const {
    buildLifecycleFrameHtml,
    buildLifecycleRenderModel,
    buildLifecycleTimelineSvg,
  } = await lifecycleRender;
  const input = await validInput();

  assert.throws(
    () => buildLifecycleRenderModel({ ...input, capturedAt: "never" }),
    /input fields drifted/,
  );
  assert.throws(
    () => buildLifecycleRenderModel({ evidence: input.evidence }),
    /input fields drifted/,
  );
  assert.throws(
    () => buildLifecycleRenderModel({ ...input, receiptSha256: input.receiptSha256.toUpperCase() }),
    /64 lowercase hexadecimal characters/,
  );
  assert.throws(
    () => buildLifecycleTimelineSvg({ ...input, receiptSha256: "0".repeat(64) }),
    /does not match canonical lifecycle evidence/,
  );

  const driftedEvidence = validEvidence();
  driftedEvidence.steps[7].count = 7;
  assert.throws(
    () => buildLifecycleRenderModel({ ...input, evidence: driftedEvidence }),
    /final_popup\.count must be 6/,
  );
  assert.throws(
    () => buildLifecycleFrameHtml(input, -1),
    /frameIndex must be an integer from 0 to 7/,
  );
  assert.throws(
    () => buildLifecycleFrameHtml(input, 1.5),
    /frameIndex must be an integer from 0 to 7/,
  );
  assert.throws(
    () => buildLifecycleFrameHtml(input, 8),
    /frameIndex must be an integer from 0 to 7/,
  );
});
