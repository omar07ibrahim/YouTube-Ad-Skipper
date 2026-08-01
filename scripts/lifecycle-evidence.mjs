const SCHEMA_VERSION = 1;
const SCENARIO = "offline-mv3-lifecycle-v1";
const STEP_KINDS = Object.freeze([
  "fresh_profile",
  "initial_action",
  "spa_rate_restore",
  "ad_pod_rotation",
  "two_tab_barrier",
  "worker_stopped",
  "worker_woken",
  "final_popup",
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "scenario",
  "fixtureFulfillments",
  "unexpectedHttpRequests",
  "steps",
]);

const STEP_KEYS = Object.freeze({
  fresh_profile: ["kind", "count", "workerGeneration"],
  initial_action: ["kind", "count", "clickCount"],
  spa_rate_restore: [
    "kind",
    "count",
    "clickCount",
    "sameDocument",
    "acceleratedRate",
    "rateAtClick",
  ],
  ad_pod_rotation: [
    "kind",
    "count",
    "clickCount",
    "sameVideoElement",
    "sourceChanged",
  ],
  two_tab_barrier: [
    "kind",
    "count",
    "countDelta",
    "clickCounts",
    "workerGeneration",
  ],
  worker_stopped: [
    "kind",
    "count",
    "activeWorkerCount",
    "workerGeneration",
  ],
  worker_woken: [
    "kind",
    "count",
    "clickCount",
    "previousWorkerGeneration",
    "workerGeneration",
    "targetChanged",
  ],
  final_popup: ["kind", "count"],
});

function fail(message) {
  throw new Error(`invalid lifecycle evidence: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, location) {
  if (!isPlainObject(value)) {
    fail(`${location} must be a plain object`);
  }
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    fail(`${location} fields drifted`);
  }
}

function requireSafeCount(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${location} must be a non-negative safe integer`);
  }
  return value;
}

function requireExactInteger(value, expected, location) {
  if (value !== expected) {
    fail(`${location} must be ${expected}`);
  }
  return value;
}

function requireTrue(value, location) {
  if (value !== true) {
    fail(`${location} must be true`);
  }
  return true;
}

function normalizedStep(value, expectedKind, index) {
  const location = `steps[${index}]`;
  const keys = STEP_KEYS[expectedKind];
  if (!isPlainObject(value)) {
    fail(`${location} must be a plain object`);
  }
  if (value.kind !== expectedKind) {
    fail(`${location}.kind must be ${expectedKind}`);
  }
  requireExactKeys(value, keys, location);

  const step = { kind: expectedKind };
  for (const key of keys.slice(1)) {
    step[key] = value[key];
  }
  step.count = requireSafeCount(step.count, `${location}.count`);
  return step;
}

export function normalizeLifecycleEvidence(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, "document");
  requireExactInteger(
    value.schemaVersion,
    SCHEMA_VERSION,
    "schemaVersion",
  );
  if (value.scenario !== SCENARIO) {
    fail(`scenario must be ${SCENARIO}`);
  }
  requireExactInteger(
    value.fixtureFulfillments,
    4,
    "fixtureFulfillments",
  );
  requireExactInteger(
    value.unexpectedHttpRequests,
    0,
    "unexpectedHttpRequests",
  );
  if (!Array.isArray(value.steps) || value.steps.length !== STEP_KINDS.length) {
    fail(`steps must contain exactly ${STEP_KINDS.length} observations`);
  }

  const steps = STEP_KINDS.map((kind, index) =>
    normalizedStep(value.steps[index], kind, index),
  );
  const [
    fresh,
    initial,
    spa,
    adPod,
    multiTab,
    stopped,
    woken,
    finalPopup,
  ] = steps;

  requireExactInteger(fresh.count, 0, "fresh_profile.count");
  requireExactInteger(
    fresh.workerGeneration,
    1,
    "fresh_profile.workerGeneration",
  );

  requireExactInteger(initial.clickCount, 1, "initial_action.clickCount");
  requireExactInteger(
    initial.count,
    fresh.count + initial.clickCount,
    "initial_action.count",
  );

  requireExactInteger(spa.clickCount, 1, "spa_rate_restore.clickCount");
  requireTrue(spa.sameDocument, "spa_rate_restore.sameDocument");
  requireExactInteger(
    spa.acceleratedRate,
    2,
    "spa_rate_restore.acceleratedRate",
  );
  requireExactInteger(spa.rateAtClick, 1, "spa_rate_restore.rateAtClick");
  requireExactInteger(
    spa.count,
    initial.count + spa.clickCount,
    "spa_rate_restore.count",
  );

  requireExactInteger(adPod.clickCount, 1, "ad_pod_rotation.clickCount");
  requireTrue(adPod.sameVideoElement, "ad_pod_rotation.sameVideoElement");
  requireTrue(adPod.sourceChanged, "ad_pod_rotation.sourceChanged");
  requireExactInteger(
    adPod.count,
    spa.count + adPod.clickCount,
    "ad_pod_rotation.count",
  );

  requireExactInteger(multiTab.countDelta, 2, "two_tab_barrier.countDelta");
  if (
    !Array.isArray(multiTab.clickCounts) ||
    multiTab.clickCounts.length !== 2 ||
    multiTab.clickCounts.some((count) => count !== 1)
  ) {
    fail("two_tab_barrier.clickCounts must be [1,1]");
  }
  requireExactInteger(
    multiTab.workerGeneration,
    1,
    "two_tab_barrier.workerGeneration",
  );
  requireExactInteger(
    multiTab.count,
    adPod.count + multiTab.countDelta,
    "two_tab_barrier.count",
  );
  multiTab.clickCounts = [...multiTab.clickCounts];

  requireExactInteger(
    stopped.activeWorkerCount,
    0,
    "worker_stopped.activeWorkerCount",
  );
  requireExactInteger(
    stopped.workerGeneration,
    1,
    "worker_stopped.workerGeneration",
  );
  requireExactInteger(stopped.count, multiTab.count, "worker_stopped.count");

  requireExactInteger(woken.clickCount, 1, "worker_woken.clickCount");
  requireExactInteger(
    woken.previousWorkerGeneration,
    stopped.workerGeneration,
    "worker_woken.previousWorkerGeneration",
  );
  requireExactInteger(
    woken.workerGeneration,
    stopped.workerGeneration + 1,
    "worker_woken.workerGeneration",
  );
  requireTrue(woken.targetChanged, "worker_woken.targetChanged");
  requireExactInteger(
    woken.count,
    stopped.count + woken.clickCount,
    "worker_woken.count",
  );
  requireExactInteger(finalPopup.count, woken.count, "final_popup.count");

  return {
    schemaVersion: SCHEMA_VERSION,
    scenario: SCENARIO,
    fixtureFulfillments: value.fixtureFulfillments,
    unexpectedHttpRequests: value.unexpectedHttpRequests,
    steps,
  };
}

export function canonicalLifecycleEvidence(value) {
  return Buffer.from(
    `${JSON.stringify(normalizeLifecycleEvidence(value), null, 2)}\n`,
    "utf8",
  );
}

export function summarizeLifecycleEvidence(value) {
  const evidence = normalizeLifecycleEvidence(value);
  const byKind = Object.fromEntries(
    evidence.steps.map((step) => [step.kind, step]),
  );
  return [
    "YouTube Ad Skipper — offline MV3 lifecycle replay",
    "",
    `fresh profile                 count=${byKind.fresh_profile.count} worker=g${byKind.fresh_profile.workerGeneration}`,
    `initial fixture              count=${byKind.initial_action.count} clicks=${byKind.initial_action.clickCount}`,
    `same-document SPA + restore  count=${byKind.spa_rate_restore.count} rate=${byKind.spa_rate_restore.acceleratedRate}x→${byKind.spa_rate_restore.rateAtClick}x`,
    `ad-pod source rotation       count=${byKind.ad_pod_rotation.count} clicks=${byKind.ad_pod_rotation.clickCount}`,
    `two-tab barrier              count=${byKind.two_tab_barrier.count} delta=${byKind.two_tab_barrier.countDelta}`,
    `worker stopped               count=${byKind.worker_stopped.count} active=${byKind.worker_stopped.activeWorkerCount}`,
    `worker woken                 count=${byKind.worker_woken.count} worker=g${byKind.worker_woken.workerGeneration}`,
    `final popup                  count=${byKind.final_popup.count}`,
    "",
    "Observed offline invariants only; live YouTube selector compatibility is not claimed.",
  ].join("\n");
}

export const LIFECYCLE_SCHEMA_VERSION = SCHEMA_VERSION;
export const LIFECYCLE_SCENARIO = SCENARIO;
export const LIFECYCLE_STEP_KINDS = STEP_KINDS;
