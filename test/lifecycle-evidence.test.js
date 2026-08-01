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
      { kind: "fresh_profile", count: 0, workerGeneration: 1 },
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
        workerGeneration: 1,
      },
      {
        kind: "worker_stopped",
        count: 5,
        activeWorkerCount: 0,
        workerGeneration: 1,
      },
      {
        kind: "worker_woken",
        count: 6,
        clickCount: 1,
        previousWorkerGeneration: 1,
        workerGeneration: 2,
        targetChanged: true,
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
      "fresh profile                 count=0 worker=g1",
      "initial fixture              count=1 clicks=1",
      "same-document SPA + restore  count=2 rate=2x→1x",
      "ad-pod source rotation       count=3 clicks=1",
      "two-tab barrier              count=5 delta=2",
      "worker stopped               count=5 active=0",
      "worker woken                 count=6 worker=g2",
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

  const sameTarget = validEvidence();
  sameTarget.steps[6].targetChanged = false;
  assert.throws(
    () => normalizeLifecycleEvidence(sameTarget),
    /worker_woken\.targetChanged must be true/,
  );

  const wrongRate = validEvidence();
  wrongRate.steps[2].rateAtClick = 2;
  assert.throws(
    () => normalizeLifecycleEvidence(wrongRate),
    /spa_rate_restore\.rateAtClick must be 1/,
  );
});
