"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const lifecycle = import("../scripts/lifecycle-evidence.mjs");

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

test("lifecycle evidence normalizes the exact observed sequence", async () => {
  const {
    LIFECYCLE_SCHEMA_VERSION,
    LIFECYCLE_SCENARIO,
    LIFECYCLE_STEP_KINDS,
    normalizeLifecycleEvidence,
  } = await lifecycle;
  const evidence = validEvidence();
  const reordered = Object.fromEntries(Object.entries(evidence).reverse());
  reordered.steps = evidence.steps.map((step) =>
    Object.fromEntries(Object.entries(step).reverse()),
  );

  assert.deepEqual(normalizeLifecycleEvidence(reordered), evidence);
  const mutable = validEvidence();
  const normalized = normalizeLifecycleEvidence(mutable);
  mutable.steps[4].clickCounts[0] = 9;
  assert.deepEqual(normalized, evidence);
  assert.equal(LIFECYCLE_SCHEMA_VERSION, 1);
  assert.equal(LIFECYCLE_SCENARIO, evidence.scenario);
  assert.deepEqual(
    LIFECYCLE_STEP_KINDS,
    evidence.steps.map((step) => step.kind),
  );
});

test("canonical lifecycle bytes and summary are stable", async () => {
  const { canonicalLifecycleEvidence, summarizeLifecycleEvidence } =
    await lifecycle;
  const evidence = validEvidence();
  const bytes = canonicalLifecycleEvidence(evidence);

  assert.deepEqual(JSON.parse(bytes), evidence);
  assert.equal(bytes.at(-1), 0x0a);
  assert.equal(bytes.toString("utf8").endsWith("\n\n"), false);
  assert.equal(
    summarizeLifecycleEvidence(evidence),
    [
      "YouTube Ad Skipper — offline MV3 lifecycle replay",
      "",
      "fresh profile                 count=0 worker=running targets=1",
      "initial fixture              count=1 clicks=1",
      "same-document SPA + restore  count=2 rate=2x→1x",
      "ad-pod source rotation       count=3 clicks=1",
      "two-tab barrier              count=5 delta=2",
      "worker stopped               last-committed=5 status=stopped targets=0",
      "worker woken                 count=6 cycle=1 targets=1",
      "final popup                  count=6",
      "",
      "Observed offline invariants only; live YouTube selector compatibility is not claimed.",
    ].join("\n"),
  );
});

test("lifecycle evidence rejects reconciliation and ordering drift", async () => {
  const { normalizeLifecycleEvidence } = await lifecycle;

  const lostUpdate = validEvidence();
  lostUpdate.steps[4].count = 4;
  assert.throws(
    () => normalizeLifecycleEvidence(lostUpdate),
    /two_tab_barrier\.count must be 5/,
  );

  const reordered = validEvidence();
  [reordered.steps[2], reordered.steps[3]] = [
    reordered.steps[3],
    reordered.steps[2],
  ];
  assert.throws(
    () => normalizeLifecycleEvidence(reordered),
    /steps\[2\]\.kind must be spa_rate_restore/,
  );

  const duplicate = validEvidence();
  duplicate.steps[3].clickCount = 2;
  assert.throws(
    () => normalizeLifecycleEvidence(duplicate),
    /ad_pod_rotation\.clickCount must be 1/,
  );
});

test("lifecycle evidence rejects nondeterministic and unbounded surface", async () => {
  const { normalizeLifecycleEvidence } = await lifecycle;

  const rawTarget = validEvidence();
  rawTarget.steps[6].targetId = "CDP-target-123";
  assert.throws(
    () => normalizeLifecycleEvidence(rawTarget),
    /steps\[6\] fields drifted/,
  );

  const unexpectedNetwork = validEvidence();
  unexpectedNetwork.unexpectedHttpRequests = 1;
  assert.throws(
    () => normalizeLifecycleEvidence(unexpectedNetwork),
    /unexpectedHttpRequests must be 0/,
  );

  const unsafeCount = validEvidence();
  unsafeCount.steps[7].count = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => normalizeLifecycleEvidence(unsafeCount),
    /non-negative safe integer/,
  );
});

test("lifecycle evidence requires the worker and rate boundaries", async () => {
  const { normalizeLifecycleEvidence } = await lifecycle;

  const missingRestart = validEvidence();
  missingRestart.steps[6].runningStatuses = ["running", "running"];
  assert.throws(
    () => normalizeLifecycleEvidence(missingRestart),
    /worker_woken\.runningStatuses must be/,
  );

  const changedVersion = validEvidence();
  changedVersion.steps[6].sameVersion = false;
  assert.throws(
    () => normalizeLifecycleEvidence(changedVersion),
    /worker_woken\.sameVersion must be true/,
  );

  const wrongRate = validEvidence();
  wrongRate.steps[2].rateAtClick = 2;
  assert.throws(
    () => normalizeLifecycleEvidence(wrongRate),
    /spa_rate_restore\.rateAtClick must be 1/,
  );
});
