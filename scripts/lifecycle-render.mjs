import { createHash } from "node:crypto";

import {
  canonicalLifecycleEvidence,
  normalizeLifecycleEvidence,
} from "./lifecycle-evidence.mjs";

const INPUT_KEYS = Object.freeze(["evidence", "receiptSha256"]);
const RECEIPT_PATTERN = /^[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const CONTRACT = deepFreeze({
  schemaVersion: 1,
  timeline: {
    width: 1440,
    height: 720,
  },
  matrix: {
    width: 1440,
    height: 960,
    columns: ["Phase", "Counter", "Categorical observation", "Scope"],
  },
  animation: {
    width: 960,
    height: 540,
    frameCount: 8,
    delaysMs: [1800, 1800, 1800, 1800, 1800, 1800, 1800, 1800],
  },
  claims: {
    categorical: "CATEGORICAL OBSERVATIONS · NOT ELAPSED TIME",
    live: "OFFLINE FIXTURE · NOT LIVE YOUTUBE ACCEPTANCE",
  },
  phases: [
    {
      kind: "fresh_profile",
      label: "Fresh profile",
      headline: "Worker ready",
      accent: "#38bdf8",
    },
    {
      kind: "initial_action",
      label: "Initial action",
      headline: "First durable count",
      accent: "#ef4444",
    },
    {
      kind: "spa_rate_restore",
      label: "Same-document SPA",
      headline: "Rate restored before click",
      accent: "#f97316",
    },
    {
      kind: "ad_pod_rotation",
      label: "Ad-pod rotation",
      headline: "New source, same video",
      accent: "#eab308",
    },
    {
      kind: "two_tab_barrier",
      label: "Two-tab barrier",
      headline: "Both clicks retained",
      accent: "#a78bfa",
    },
    {
      kind: "worker_stopped",
      label: "Worker stopped",
      headline: "Target leaves the runtime",
      accent: "#64748b",
    },
    {
      kind: "worker_woken",
      label: "Worker woken",
      headline: "Message restores execution",
      accent: "#14b8a6",
    },
    {
      kind: "final_popup",
      label: "Final popup",
      headline: "Visible state converged",
      accent: "#22c55e",
    },
  ],
});

function fail(message) {
  throw new Error(`invalid lifecycle render input: ${message}`);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value);
}

function digestCanonicalEvidence(evidence) {
  return createHash("sha256")
    .update(canonicalLifecycleEvidence(evidence))
    .digest("hex");
}

function validatedInput(input) {
  requireExactKeys(input, INPUT_KEYS, "input");
  if (
    typeof input.receiptSha256 !== "string" ||
    !RECEIPT_PATTERN.test(input.receiptSha256)
  ) {
    fail("receiptSha256 must be exactly 64 lowercase hexadecimal characters");
  }

  const evidence = normalizeLifecycleEvidence(input.evidence);
  const actualSha256 = digestCanonicalEvidence(evidence);
  if (actualSha256 !== input.receiptSha256) {
    fail("receiptSha256 does not match canonical lifecycle evidence");
  }
  return {
    evidence,
    receiptSha256: actualSha256,
  };
}

function factsForStep(step) {
  switch (step.kind) {
    case "fresh_profile":
      return {
        facts: [
          `count ${step.count}`,
          `${step.runningStatus} · targets ${step.activeTargetCount}`,
        ],
        observation:
          `worker ${step.runningStatus} · targets ${step.activeTargetCount}`,
        scope: `restart cycle ${step.restartCycle}`,
      };
    case "initial_action":
      return {
        facts: [`count ${step.count}`, `observed clicks ${step.clickCount}`],
        observation: `${step.clickCount} observed click`,
        scope: "offline initial fixture",
      };
    case "spa_rate_restore":
      return {
        facts: [
          `count ${step.count} · same document`,
          `${step.acceleratedRate}× accelerated → ${step.rateAtClick}× at click`,
        ],
        observation:
          `same document · ${step.acceleratedRate}× → ${step.rateAtClick}×`,
        scope: `${step.clickCount} observed click`,
      };
    case "ad_pod_rotation":
      return {
        facts: [
          `count ${step.count} · source changed`,
          `same video · clicks ${step.clickCount}`,
        ],
        observation: "same video · source changed",
        scope: `${step.clickCount} observed click`,
      };
    case "two_tab_barrier":
      return {
        facts: [
          `count ${step.count} · delta ${step.countDelta}`,
          `tab clicks [${step.clickCounts.join(", ")}]`,
        ],
        observation:
          `delta ${step.countDelta} · tab clicks [${step.clickCounts.join(", ")}]`,
        scope: `restart cycle ${step.restartCycle}`,
      };
    case "worker_stopped":
      return {
        facts: [
          `last committed count ${step.count}`,
          `${step.runningStatuses.join(" → ")} · targets ${step.activeTargetCounts.join(" → ")}`,
        ],
        observation:
          `${step.runningStatuses.join(" → ")} · targets ${step.activeTargetCounts.join(" → ")}`,
        scope: "last committed before stop",
      };
    case "worker_woken":
      return {
        facts: [
          `count ${step.count} · stopped → running`,
          `cycle ${step.previousRestartCycle} → ${step.restartCycle} · same registration/version`,
        ],
        observation:
          `stopped → running · targets ${step.activeTargetCounts[1]} → ${step.activeTargetCounts[2]}`,
        scope:
          `cycle ${step.previousRestartCycle} → ${step.restartCycle} · same registration/version`,
      };
    case "final_popup":
      return {
        facts: [`popup count ${step.count}`, "matches lifecycle count"],
        observation: `popup count ${step.count}`,
        scope: "matches lifecycle count",
      };
    default:
      fail(`unsupported lifecycle phase: ${step.kind}`);
  }
}

function buildModel(validated) {
  const phaseByKind = Object.fromEntries(
    CONTRACT.phases.map((phase) => [phase.kind, phase]),
  );
  const frames = validated.evidence.steps.map((step, index) => {
    const phase = phaseByKind[step.kind];
    if (!phase) {
      fail(`missing render phase for ${step.kind}`);
    }
    const facts = factsForStep(step);
    return {
      index,
      ordinal: index + 1,
      kind: step.kind,
      label: phase.label,
      headline: phase.headline,
      accent: phase.accent,
      count: step.count,
      facts: facts.facts,
      observation: facts.observation,
      scope: facts.scope,
    };
  });

  if (frames.length !== CONTRACT.animation.frameCount) {
    fail(`render model must contain ${CONTRACT.animation.frameCount} phases`);
  }

  return deepFreeze({
    schemaVersion: CONTRACT.schemaVersion,
    receiptSha256: validated.receiptSha256,
    claims: CONTRACT.claims,
    dimensions: {
      timeline: CONTRACT.timeline,
      matrix: CONTRACT.matrix,
      animation: CONTRACT.animation,
    },
    matrixColumns: CONTRACT.matrix.columns,
    frames,
  });
}

export function lifecycleReceiptSha256(evidence) {
  return digestCanonicalEvidence(evidence);
}

export function buildLifecycleRenderModel(input) {
  return buildModel(validatedInput(input));
}

export function buildLifecycleTranscript(input) {
  const model = buildLifecycleRenderModel(input);
  const lines = model.frames.map((frame) => {
    const ordinal = String(frame.ordinal).padStart(2, "0");
    return `${ordinal}  ${frame.label.padEnd(22)} count=${String(frame.count).padEnd(2)}  ${frame.observation}`;
  });
  return Buffer.from(
    [
      "YouTube Ad Skipper — offline MV3 lifecycle receipt",
      `Receipt SHA-256: ${model.receiptSha256}`,
      "",
      ...lines,
      "",
      "Classification: categorical observations; sequence positions are not elapsed-time measurements.",
      "Scope: offline fixture evidence; live YouTube acceptance is not claimed.",
      "",
    ].join("\n"),
    "utf8",
  );
}

export function buildLifecycleTimelineSvg(input) {
  const model = buildLifecycleRenderModel(input);
  const cards = model.frames.map((frame) => {
    const column = frame.index % 4;
    const row = Math.floor(frame.index / 4);
    const x = 42 + column * 348;
    const y = 154 + row * 218;
    return `
    <g aria-label="Step ${frame.ordinal}: ${escapeXml(frame.label)}">
      <rect x="${x}" y="${y}" width="316" height="184" rx="18"
            fill="#111827" stroke="#334155" stroke-width="2"/>
      <rect x="${x}" y="${y}" width="7" height="184" rx="4"
            fill="${frame.accent}"/>
      <circle cx="${x + 38}" cy="${y + 38}" r="19" fill="${frame.accent}"/>
      <text x="${x + 38}" y="${y + 44}" text-anchor="middle" class="ordinal">${frame.ordinal}</text>
      <text x="${x + 68}" y="${y + 34}" class="label">${escapeXml(frame.label)}</text>
      <text x="${x + 68}" y="${y + 58}" class="headline">${escapeXml(frame.headline)}</text>
      <text x="${x + 24}" y="${y + 112}" class="count">COUNT ${frame.count}</text>
      <text x="${x + 24}" y="${y + 143}" class="fact">${escapeXml(frame.facts[0])}</text>
      <text x="${x + 24}" y="${y + 166}" class="fact">${escapeXml(frame.facts[1])}</text>
    </g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CONTRACT.timeline.width}" height="${CONTRACT.timeline.height}"
     viewBox="0 0 ${CONTRACT.timeline.width} ${CONTRACT.timeline.height}" role="img"
     aria-labelledby="lifecycle-title lifecycle-description">
  <title id="lifecycle-title">Offline Manifest V3 lifecycle evidence timeline</title>
  <desc id="lifecycle-description">Eight categorical offline fixture observations from a fresh profile through a stopped and woken service worker to the final popup. Sequence position is not elapsed time, and live YouTube acceptance is not claimed. Receipt SHA-256 ${model.receiptSha256}.</desc>
  <style>
    .eyebrow { fill: #f87171; font: 800 13px system-ui, sans-serif; letter-spacing: 1.8px; }
    .heading { fill: #f8fafc; font: 750 30px system-ui, sans-serif; }
    .ordinal { fill: #08111f; font: 800 14px system-ui, sans-serif; }
    .label { fill: #f8fafc; font: 720 16px system-ui, sans-serif; }
    .headline { fill: #94a3b8; font: 560 13px system-ui, sans-serif; }
    .count { fill: #f8fafc; font: 800 23px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .fact { fill: #cbd5e1; font: 550 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .claim { fill: #cbd5e1; font: 750 12px system-ui, sans-serif; letter-spacing: 1.1px; }
    .receipt { fill: #94a3b8; font: 550 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
  <rect width="1440" height="720" rx="24" fill="#090d16"/>
  <text x="42" y="43" class="eyebrow">REPRODUCIBLE LIFECYCLE RECEIPT</text>
  <text x="42" y="84" class="heading">Manifest V3 state transitions, observed offline</text>
  <text x="42" y="118" class="claim">${escapeXml(model.claims.categorical)}</text>
  <text x="1398" y="118" text-anchor="end" class="claim">${escapeXml(model.claims.live)}</text>
${cards}
  <line x1="42" y1="610" x2="1398" y2="610" stroke="#334155"/>
  <text x="42" y="646" class="receipt">RECEIPT SHA-256 ${model.receiptSha256}</text>
  <text x="42" y="678" class="receipt">Eight ordered observations · position encodes sequence only</text>
</svg>
`;
}

export function buildLifecycleMatrixHtml(input) {
  const model = buildLifecycleRenderModel(input);
  const rows = model.frames.map((frame) => `
          <tr>
            <th scope="row"><span>${frame.ordinal}</span>${escapeHtml(frame.label)}</th>
            <td class="count">${frame.count}</td>
            <td>${escapeHtml(frame.observation)}</td>
            <td>${escapeHtml(frame.scope)}</td>
          </tr>`).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=${CONTRACT.matrix.width}, initial-scale=1">
    <title>Offline MV3 lifecycle evidence matrix</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${CONTRACT.matrix.width}px; height: ${CONTRACT.matrix.height}px; margin: 0; overflow: hidden; }
      body { padding: 42px; background: #090d16; color: #e2e8f0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      .eyebrow { margin: 0 0 10px; color: #f87171; font-size: 13px; font-weight: 800; letter-spacing: 1.8px; }
      h1 { margin: 0; color: #f8fafc; font-size: 31px; line-height: 1.15; }
      .claims { display: flex; justify-content: space-between; margin: 18px 0 24px; color: #cbd5e1; font-size: 12px; font-weight: 750; letter-spacing: 1px; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; border: 1px solid #334155; border-radius: 18px; background: #111827; table-layout: fixed; }
      thead th { height: 54px; padding: 0 18px; border-bottom: 1px solid #475569; background: #172033; color: #94a3b8; font-size: 12px; letter-spacing: .9px; text-align: left; text-transform: uppercase; }
      thead th:nth-child(1) { width: 23%; }
      thead th:nth-child(2) { width: 10%; text-align: center; }
      thead th:nth-child(3) { width: 37%; }
      thead th:nth-child(4) { width: 30%; }
      tbody th, tbody td { height: 70px; padding: 12px 18px; border-bottom: 1px solid #253146; color: #cbd5e1; font-size: 14px; line-height: 1.35; text-align: left; }
      tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
      tbody th { color: #f8fafc; font-weight: 700; }
      tbody th span { display: inline-grid; width: 28px; height: 28px; margin-right: 12px; place-items: center; border-radius: 50%; background: #ef4444; color: #fff; font-size: 12px; }
      tbody td.count { color: #f8fafc; font: 800 20px ui-monospace, SFMono-Regular, Consolas, monospace; text-align: center; }
      footer { margin-top: 24px; padding-top: 20px; border-top: 1px solid #334155; color: #94a3b8; font: 550 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      footer strong { color: #cbd5e1; }
    </style>
  </head>
  <body>
    <header>
      <p class="eyebrow">REPRODUCIBLE LIFECYCLE RECEIPT</p>
      <h1>Offline Manifest V3 observation matrix</h1>
      <div class="claims"><span>${escapeHtml(model.claims.categorical)}</span><span>${escapeHtml(model.claims.live)}</span></div>
    </header>
    <main>
      <table aria-label="Eight categorical lifecycle observations">
        <thead><tr>${model.matrixColumns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead>
        <tbody>${rows}
        </tbody>
      </table>
    </main>
    <footer><strong>RECEIPT SHA-256</strong> ${model.receiptSha256}<br>Sequence order is evidence of transition order only; it is not a timing scale.</footer>
  </body>
</html>`;
}

export function buildLifecycleFrameHtml(input, frameIndex) {
  const model = buildLifecycleRenderModel(input);
  if (
    !Number.isSafeInteger(frameIndex) ||
    frameIndex < 0 ||
    frameIndex >= CONTRACT.animation.frameCount
  ) {
    fail(`frameIndex must be an integer from 0 to ${CONTRACT.animation.frameCount - 1}`);
  }
  const frame = model.frames[frameIndex];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=${CONTRACT.animation.width}, initial-scale=1">
    <title>Lifecycle observation ${frame.ordinal}: ${escapeHtml(frame.label)}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${CONTRACT.animation.width}px; height: ${CONTRACT.animation.height}px; margin: 0; overflow: hidden; }
      body { padding: 34px 38px; background: radial-gradient(circle at 88% 10%, ${frame.accent}2e, transparent 34%), #090d16; color: #e2e8f0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      header { display: flex; justify-content: space-between; align-items: center; }
      .eyebrow, .scope { margin: 0; font-size: 11px; font-weight: 800; letter-spacing: 1.35px; }
      .eyebrow { color: #f87171; }
      .scope { color: #cbd5e1; }
      main { display: grid; grid-template-columns: 230px 1fr; gap: 36px; align-items: stretch; height: 344px; margin-top: 25px; }
      .counter, .observation { border: 1px solid #334155; border-radius: 22px; background: rgb(17 24 39 / 94%); }
      .counter { display: grid; place-content: center; text-align: center; box-shadow: inset 7px 0 ${frame.accent}; }
      .counter .caption { color: #94a3b8; font-size: 12px; font-weight: 750; letter-spacing: 1.6px; }
      .counter strong { display: block; margin-top: 8px; color: #f8fafc; font: 850 82px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .observation { padding: 32px 36px; }
      .step { margin: 0 0 12px; color: ${frame.accent}; font: 750 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
      h1 { margin: 0; color: #f8fafc; font-size: 37px; line-height: 1.08; letter-spacing: -.7px; }
      h2 { margin: 10px 0 26px; color: #94a3b8; font-size: 19px; font-weight: 600; }
      ul { margin: 0; padding: 0; list-style: none; }
      li { position: relative; margin-top: 13px; padding-left: 24px; color: #cbd5e1; font: 650 16px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
      li::before { position: absolute; left: 0; color: ${frame.accent}; content: "◆"; }
      footer { margin-top: 22px; padding-top: 17px; border-top: 1px solid #334155; color: #94a3b8; font: 550 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      footer strong { color: #cbd5e1; }
    </style>
  </head>
  <body>
    <header><p class="eyebrow">${escapeHtml(model.claims.categorical)}</p><p class="scope">${escapeHtml(model.claims.live)}</p></header>
    <main>
      <section class="counter" aria-label="Observed counter ${frame.count}"><span class="caption">OBSERVED COUNT</span><strong>${frame.count}</strong></section>
      <section class="observation">
        <p class="step">STEP ${frame.ordinal} / ${CONTRACT.animation.frameCount} · ${escapeHtml(frame.kind)}</p>
        <h1>${escapeHtml(frame.label)}</h1>
        <h2>${escapeHtml(frame.headline)}</h2>
        <ul>${frame.facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>
      </section>
    </main>
    <footer><strong>RECEIPT SHA-256</strong> ${model.receiptSha256}<br>Categorical sequence position only · no elapsed-time claim · no live-site claim</footer>
  </body>
</html>`;
}

export const LIFECYCLE_RENDER_CONTRACT = CONTRACT;
