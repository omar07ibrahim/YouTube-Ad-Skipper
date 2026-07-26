import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import gifenc from "gifenc";
import pngjs from "pngjs";

const require = createRequire(import.meta.url);
const { choosePlaybackRate } = require("../content.js");
const { GIFEncoder, applyPalette, quantize } = gifenc;
const { version: playwrightVersion } = require("playwright/package.json");
const { PNG } = pngjs;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(ROOT, "docs", "assets");
const EVIDENCE_DIR = path.join(ROOT, "docs", "evidence");
const ARTIFACT_DIR = path.join(ROOT, ".artifacts");
const CONTRACT = JSON.parse(
  await readFile(path.join(SCRIPT_DIR, "visual-contract.json"), "utf8"),
);
const FIXTURE_URL = CONTRACT.fixtureUrl;
const WORKFLOW_GIF = CONTRACT.workflowGif;

function relative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join("/");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function normalizeIcon() {
  const sourcePath = path.join(ROOT, "images", "icon126-source.png");
  const outputPath = path.join(ROOT, "images", "icon128.png");
  const sourceBytes = await readFile(sourcePath);
  const source = PNG.sync.read(sourceBytes);

  if (source.width !== 126 || source.height !== 126) {
    throw new Error("legacy icon source must remain exactly 126×126");
  }

  const output = new PNG({ width: 128, height: 128 });
  output.data.fill(0);
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const targetStart = ((y + 1) * output.width + 1) * 4;
    source.data.copy(
      output.data,
      targetStart,
      sourceStart,
      sourceStart + source.width * 4,
    );
  }

  await writeFile(outputPath, PNG.sync.write(output));

  const decoded = PNG.sync.read(await readFile(outputPath));
  if (decoded.width !== 128 || decoded.height !== 128) {
    throw new Error("normalized icon is not 128×128");
  }
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const targetStart = ((y + 1) * decoded.width + 1) * 4;
    if (
      !source.data
        .subarray(sourceStart, sourceStart + source.width * 4)
        .equals(
          decoded.data.subarray(
            targetStart,
            targetStart + source.width * 4,
          ),
        )
    ) {
      throw new Error("normalized icon changed a source pixel");
    }
  }
  for (let index = 0; index < 128; index += 1) {
    const topAlpha = decoded.data[(index * 4) + 3];
    const bottomAlpha =
      decoded.data[(((127 * 128) + index) * 4) + 3];
    const leftAlpha = decoded.data[((index * 128) * 4) + 3];
    const rightAlpha =
      decoded.data[(((index * 128) + 127) * 4) + 3];
    if (topAlpha || bottomAlpha || leftAlpha || rightAlpha) {
      throw new Error("normalized icon border is not fully transparent");
    }
  }
}

async function renderWorkflowFrame(page, frame, outputPath) {
  const image = (await readFile(frame.imagePath)).toString("base64");
  await page.setViewportSize({
    width: WORKFLOW_GIF.width,
    height: WORKFLOW_GIF.height,
  });
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body {
            width: ${WORKFLOW_GIF.width}px;
            height: ${WORKFLOW_GIF.height}px;
            margin: 0;
            overflow: hidden;
          }
          body {
            display: grid;
            grid-template-columns: 270px 1fr;
            gap: 30px;
            padding: 38px;
            background:
              radial-gradient(circle at 88% 8%, rgb(239 68 68 / 18%), transparent 34%),
              #090d16;
            color: #e2e8f0;
            font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          }
          aside {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 22px 0 18px;
          }
          .eyebrow {
            margin: 0 0 18px;
            color: #f87171;
            font-size: 13px;
            font-weight: 800;
            letter-spacing: 1.7px;
          }
          .step {
            margin: 0 0 10px;
            color: #94a3b8;
            font: 700 14px ui-monospace, SFMono-Regular, Consolas, monospace;
          }
          h1 {
            margin: 0;
            color: #f8fafc;
            font-size: 34px;
            line-height: 1.08;
            letter-spacing: -1px;
          }
          .detail {
            margin: 20px 0 0;
            color: #cbd5e1;
            font-size: 16px;
            line-height: 1.55;
          }
          .boundary {
            margin: 0;
            padding-top: 16px;
            border-top: 1px solid #334155;
            color: #94a3b8;
            font: 600 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
          }
          main {
            display: grid;
            place-items: center;
            min-width: 0;
            border: 1px solid #334155;
            border-radius: 22px;
            background: #111827;
            box-shadow: 0 24px 70px rgb(0 0 0 / 36%);
            overflow: hidden;
          }
          img {
            display: block;
            max-width: 100%;
            max-height: 458px;
            object-fit: contain;
          }
        </style>
      </head>
      <body>
        <aside>
          <div>
            <p class="eyebrow">REAL UNPACKED EXTENSION · OFFLINE</p>
            <p class="step">${escapeHtml(frame.step)}</p>
            <h1>${escapeHtml(frame.title)}</h1>
            <p class="detail">${escapeHtml(frame.detail)}</p>
          </div>
          <p class="boundary">${escapeHtml(frame.boundary)}</p>
        </aside>
        <main>
          <img src="data:image/png;base64,${image}" alt="">
        </main>
      </body>
    </html>`);
  await page.screenshot({
    animations: "disabled",
    path: outputPath,
  });
}

async function encodeWorkflowGif(framePaths) {
  if (
    !Number.isInteger(WORKFLOW_GIF.width) ||
    !Number.isInteger(WORKFLOW_GIF.height) ||
    !Array.isArray(WORKFLOW_GIF.delaysMs) ||
    framePaths.length !== WORKFLOW_GIF.frameCount ||
    framePaths.length !== WORKFLOW_GIF.delaysMs.length
  ) {
    throw new Error("invalid workflow GIF contract");
  }

  const gif = GIFEncoder();
  for (const [index, framePath] of framePaths.entries()) {
    const frame = PNG.sync.read(await readFile(framePath));
    if (
      frame.width !== WORKFLOW_GIF.width ||
      frame.height !== WORKFLOW_GIF.height
    ) {
      throw new Error("workflow GIF frame dimensions drifted");
    }
    const palette = quantize(frame.data, 256);
    const indexed = applyPalette(frame.data, palette);
    gif.writeFrame(indexed, frame.width, frame.height, {
      delay: WORKFLOW_GIF.delaysMs[index],
      dispose: 1,
      palette,
      repeat: 0,
    });
  }
  gif.finish();
  await writeFile(
    path.join(ASSET_DIR, "offline-workflow.gif"),
    Buffer.from(gif.bytes()),
  );
}

function buildPolicyTranscript() {
  const scenarios = [
    {
      name: "grace window",
      originalRate: 1,
      duration: 30,
      currentTime: 0,
      adAgeMs: 5_999,
    },
    {
      name: "long ad",
      originalRate: 1,
      duration: 30,
      currentTime: 0,
      adAgeMs: 6_000,
    },
    {
      name: "short remainder",
      originalRate: 1,
      duration: 30,
      currentTime: 22,
      adAgeMs: 6_000,
    },
    {
      name: "user-selected 3x",
      originalRate: 3,
      duration: 30,
      currentTime: 5,
      adAgeMs: 10_000,
    },
    {
      name: "unknown duration",
      originalRate: 1.5,
      duration: Number.NaN,
      currentTime: 0,
      adAgeMs: 10_000,
    },
  ];

  const rows = scenarios.map((scenario) => {
    const result = choosePlaybackRate(scenario);
    const remaining = Number.isFinite(scenario.duration)
      ? `${scenario.duration - scenario.currentTime}s`
      : "unknown";
    return [
      scenario.name.padEnd(18),
      `${(scenario.adAgeMs / 1_000).toFixed(3)}s`.padStart(8),
      remaining.padStart(9),
      `${scenario.originalRate}x`.padStart(8),
      `${result}x`.padStart(7),
    ].join("  ");
  });

  return [
    "YouTube Ad Skipper — policy matrix",
    "",
    "scenario                 age  remaining  original   result",
    "------------------  --------  ---------  --------  -------",
    ...rows,
    "",
    "Rates computed by content.js::choosePlaybackRate from the scenarios above.",
  ].join("\n");
}

function buildArchitectureSvg() {
  const nodes = [
    {
      x: 42,
      y: 176,
      width: 190,
      title: "YouTube player",
      detail: "DOM adapter",
      accent: "#64748b",
    },
    {
      x: 286,
      y: 96,
      width: 228,
      title: "Content controller",
      detail: "one declarative instance",
      accent: "#ef4444",
    },
    {
      x: 286,
      y: 260,
      width: 228,
      title: "Rate ownership",
      detail: "grace · cap · restore",
      accent: "#f97316",
    },
    {
      x: 568,
      y: 176,
      width: 210,
      title: "Message boundary",
      detail: "exact sender + type",
      accent: "#8b5cf6",
    },
    {
      x: 832,
      y: 96,
      width: 210,
      title: "MV3 worker",
      detail: "serialized updates",
      accent: "#3b82f6",
    },
    {
      x: 832,
      y: 260,
      width: 210,
      title: "Trusted storage",
      detail: "one local integer",
      accent: "#14b8a6",
    },
    {
      x: 1096,
      y: 176,
      width: 174,
      title: "Popup + badge",
      detail: "bounded display",
      accent: "#22c55e",
    },
  ];
  const arrows = [
    [232, 228, 286, 148],
    [232, 228, 286, 312],
    [514, 148, 568, 228],
    [514, 312, 568, 228],
    [778, 228, 832, 148],
    [937, 202, 937, 260],
    [1042, 312, 1096, 228],
  ];
  const nodeMarkup = nodes
    .map(
      ({ x, y, width, title, detail, accent }) => `
        <g>
          <rect x="${x}" y="${y}" width="${width}" height="104" rx="18"
                fill="#111827" stroke="#334155" stroke-width="2"/>
          <rect x="${x}" y="${y}" width="7" height="104" rx="4"
                fill="${accent}"/>
          <text x="${x + 24}" y="${y + 44}" class="title">${escapeXml(title)}</text>
          <text x="${x + 24}" y="${y + 72}" class="detail">${escapeXml(detail)}</text>
        </g>`,
    )
    .join("");
  const arrowMarkup = arrows
    .map(
      ([x1, y1, x2, y2]) =>
        `<path d="M ${x1} ${y1} L ${x2} ${y2}" class="arrow"/>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1312" height="456"
     viewBox="0 0 1312 456" role="img"
     aria-labelledby="title description">
  <title id="title">YouTube Ad Skipper runtime architecture</title>
  <desc id="description">The YouTube player feeds one content controller and rate ownership state machine. Exact messages cross into a Manifest V3 worker, trusted local storage, and the popup badge.</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3"
            orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
    </marker>
    <style>
      .title { fill: #f8fafc; font: 700 19px system-ui, sans-serif; }
      .detail { fill: #94a3b8; font: 500 15px system-ui, sans-serif; }
      .eyebrow { fill: #f87171; font: 700 13px system-ui, sans-serif; letter-spacing: 2px; }
      .heading { fill: #f8fafc; font: 750 28px system-ui, sans-serif; }
      .arrow { fill: none; stroke: #64748b; stroke-width: 3; marker-end: url(#arrow); }
    </style>
  </defs>
  <rect width="1312" height="456" rx="24" fill="#090d16"/>
  <text x="42" y="48" class="eyebrow">RUNTIME DATA FLOW</text>
  <text x="42" y="84" class="heading">One controller, one bounded message path</text>
${arrowMarkup}
${nodeMarkup}
</svg>
`;
}

function buildSetupSvg() {
  const steps = [
    ["1", "Clone", "repository"],
    ["2", "Open", "chrome://extensions"],
    ["3", "Enable", "Developer mode"],
    ["4", "Load", "unpacked root"],
    ["5", "Inspect", "popup + console"],
  ];
  const nodes = steps
    .map(([number, title, detail], index) => {
      const x = 38 + index * 232;
      return `
        <g>
          <circle cx="${x + 24}" cy="148" r="24" fill="#ef4444"/>
          <text x="${x + 24}" y="155" text-anchor="middle" class="number">${number}</text>
          <rect x="${x + 60}" y="103" width="158" height="90" rx="16"
                fill="#111827" stroke="#334155" stroke-width="2"/>
          <text x="${x + 78}" y="139" class="title">${escapeXml(title)}</text>
          <text x="${x + 78}" y="166" class="detail">${escapeXml(detail)}</text>
        </g>`;
    })
    .join("");
  const arrows = Array.from({ length: 4 }, (_, index) => {
    const start = 256 + index * 232;
    return `<path d="M ${start} 148 L ${start + 26} 148" class="arrow"/>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="260"
     viewBox="0 0 1200 260" role="img" aria-labelledby="title description">
  <title id="title">Unpacked extension setup flow</title>
  <desc id="description">Clone the repository, open Chrome extensions, enable Developer mode, load the unpacked repository root, and inspect the popup and console.</desc>
  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
            orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L8,3 z" fill="#64748b"/>
    </marker>
    <style>
      .eyebrow { fill: #f87171; font: 700 13px system-ui, sans-serif; letter-spacing: 2px; }
      .heading { fill: #f8fafc; font: 750 25px system-ui, sans-serif; }
      .number { fill: #fff; font: 750 15px system-ui, sans-serif; }
      .title { fill: #f8fafc; font: 700 17px system-ui, sans-serif; }
      .detail { fill: #94a3b8; font: 500 13px ui-monospace, monospace; }
      .arrow { fill: none; stroke: #64748b; stroke-width: 3; marker-end: url(#arrow); }
    </style>
  </defs>
  <rect width="1200" height="260" rx="24" fill="#090d16"/>
  <text x="38" y="42" class="eyebrow">SETUP · NO BUILD STEP</text>
  <text x="38" y="76" class="heading">From clone to a loaded Manifest V3 extension</text>
${arrows}
${nodes}
</svg>
`;
}

function runCoverage() {
  return readdir(path.join(ROOT, "test")).then((entries) => {
    const testFiles = entries
      .filter((entry) => entry.endsWith(".test.js"))
      .sort()
      .map((entry) => path.join("test", entry));
    const result = spawnSync(
      process.execPath,
      ["--experimental-test-coverage", "--test", ...testFiles],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          LC_ALL: "C",
          NO_COLOR: "1",
          TZ: "UTC",
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `coverage command failed\n${result.stdout}\n${result.stderr}`,
      );
    }

    const wanted = new Set(["background.js", "content.js", "popup.js"]);
    const coverage = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(
        /^#\s+([^|]+?)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|/,
      );
      if (match && wanted.has(match[1].trim())) {
        coverage.push({
          file: match[1].trim(),
          lines: Number(match[2]),
          branches: Number(match[3]),
          functions: Number(match[4]),
        });
      }
    }
    coverage.sort((left, right) => left.file.localeCompare(right.file));
    if (coverage.length !== wanted.size) {
      throw new Error("could not parse coverage for all extension scripts");
    }
    return coverage;
  });
}

function buildCoverageSvg(coverage) {
  const metrics = [
    ["lines", "#ef4444"],
    ["branches", "#8b5cf6"],
    ["functions", "#14b8a6"],
  ];
  const rows = coverage
    .map((entry, rowIndex) => {
      const y = 152 + rowIndex * 124;
      const bars = metrics
        .map(([metric, color], metricIndex) => {
          const barY = y + metricIndex * 27;
          const value = entry[metric];
          const width = Math.round(value * 6.2);
          return `
            <text x="188" y="${barY + 14}" class="metric">${metric}</text>
            <rect x="280" y="${barY}" width="620" height="18" rx="9" fill="#1e293b"/>
            <rect x="280" y="${barY}" width="${width}" height="18" rx="9" fill="${color}"/>
            <text x="920" y="${barY + 14}" class="value">${value.toFixed(2)}%</text>`;
        })
        .join("");
      return `
        <text x="42" y="${y + 14}" class="file">${escapeXml(entry.file)}</text>
${bars}`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="530"
     viewBox="0 0 1040 530" role="img" aria-labelledby="title description">
  <title id="title">Extension source coverage</title>
  <desc id="description">Line, branch, and function coverage produced by the Node test runner for background, content, and popup scripts.</desc>
  <style>
    .eyebrow { fill: #f87171; font: 700 13px system-ui, sans-serif; letter-spacing: 2px; }
    .heading { fill: #f8fafc; font: 750 28px system-ui, sans-serif; }
    .file { fill: #f8fafc; font: 700 17px ui-monospace, monospace; }
    .metric { fill: #94a3b8; font: 500 13px system-ui, sans-serif; }
    .value { fill: #cbd5e1; font: 650 13px ui-monospace, monospace; }
  </style>
  <rect width="1040" height="530" rx="24" fill="#090d16"/>
  <text x="42" y="48" class="eyebrow">MEASURED EVIDENCE</text>
  <text x="42" y="84" class="heading">Node built-in coverage</text>
${rows}
</svg>
`;
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>YTAS offline DOM contract fixture</title>
    <style>
      * { box-sizing: border-box; }
      body {
        width: 720px;
        height: 440px;
        margin: 0;
        padding: 28px;
        overflow: hidden;
        background: #090d16;
        color: #e2e8f0;
        font: 16px system-ui, sans-serif;
      }
      .fixture-label {
        margin: 0 0 14px;
        color: #f87171;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 1.6px;
      }
      .html5-video-player {
        position: relative;
        width: 664px;
        height: 332px;
        border: 1px solid #334155;
        border-radius: 16px;
        background:
          linear-gradient(145deg, rgb(30 41 59 / 92%), rgb(15 23 42 / 98%));
        box-shadow: 0 18px 48px rgb(0 0 0 / 30%);
      }
      .player-title {
        position: absolute;
        top: 24px;
        left: 26px;
        margin: 0;
        color: #94a3b8;
        font: 650 13px ui-monospace, monospace;
      }
      .status {
        position: absolute;
        right: 26px;
        bottom: 24px;
        margin: 0;
        color: #86efac;
        font: 700 13px ui-monospace, monospace;
      }
      .ytp-ad-skip-button-modern {
        position: absolute;
        left: 50%;
        top: 50%;
        min-width: 220px;
        padding: 16px 24px;
        transform: translate(-50%, -50%);
        border: 1px solid #475569;
        border-radius: 999px;
        background: #f8fafc;
        color: #0f172a;
        font: 750 15px system-ui, sans-serif;
      }
    </style>
  </head>
  <body data-fixture="offline-dom-contract">
    <p class="fixture-label">OFFLINE DOM-CONTRACT FIXTURE · NETWORK DISABLED</p>
    <main class="html5-video-player ad-showing">
      <video class="html5-main-video"></video>
      <p class="player-title">YouTube player adapter boundary</p>
      <button class="ytp-ad-skip-button-modern" type="button">Fixture skip</button>
      <p class="status" aria-live="polite">waiting for content script</p>
    </main>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        document.body.dataset.skipClicked = "true";
        document.querySelector("button").textContent = "Skip action handled";
        document.querySelector(".status").textContent =
          "content script → worker → storage";
      });
    </script>
  </body>
</html>`;
}

async function inspectNetworkBoundary() {
  const interfaceNames = (await readdir("/sys/class/net")).sort();
  const addressEntries = Object.entries(networkInterfaces());
  const nonLoopbackAddresses = addressEntries.flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((address) => !address.internal)
      .map((address) => `${name}:${address.family}`),
  );
  const routeLines = (await readFile("/proc/net/route", "utf8"))
    .trim()
    .split("\n")
    .slice(1);
  const defaultRoutePresent = routeLines.some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length > 1 && fields[1] === "00000000";
  });

  if (
    JSON.stringify(interfaceNames) !==
      JSON.stringify(CONTRACT.networkInterfaces) ||
    nonLoopbackAddresses.length !== 0 ||
    defaultRoutePresent !== CONTRACT.defaultRoutePresent
  ) {
    throw new Error(
      "visual capture requires the loopback-only Docker network namespace",
    );
  }

  return {
    interfaceNames,
    nonLoopbackAddressCount: nonLoopbackAddresses.length,
    defaultRoutePresent,
  };
}

async function captureBrowserVisuals(policyTranscript) {
  const networkBoundary = await inspectNetworkBoundary();
  const profileDir = path.join(ARTIFACT_DIR, "visual-profile");
  await rm(profileDir, { force: true, recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    let fixtureFulfillments = 0;
    await context.route("https://**/*", async (route) => {
      if (route.request().url() === FIXTURE_URL) {
        fixtureFulfillments += 1;
        await route.fulfill({
          body: fixtureHtml(),
          contentType: "text/html; charset=utf-8",
          status: 200,
        });
        return;
      }
      await route.abort("blockedbyclient");
    });
    await context.route("http://**/*", (route) => route.abort("blockedbyclient"));

    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }
    const extensionId = new URL(worker.url()).hostname;

    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 336, height: 600 });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage
      .locator("#adsSkippedCount")
      .filter({ hasText: "0" })
      .waitFor({ state: "visible" });
    const initialCount = Number(
      await popupPage.locator("#adsSkippedCount").textContent(),
    );
    const workflowDir = path.join(ARTIFACT_DIR, "workflow-frames");
    await rm(workflowDir, { force: true, recursive: true });
    await mkdir(workflowDir, { recursive: true });
    const initialPopupPath = path.join(workflowDir, "popup-initial.png");
    await popupPage.locator("body").screenshot({
      animations: "disabled",
      path: initialPopupPath,
    });

    const fixturePage = await context.newPage();
    await fixturePage.setViewportSize({ width: 720, height: 440 });
    await fixturePage.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });
    await fixturePage.waitForFunction(
      () => document.body.dataset.skipClicked === "true",
      null,
      { timeout: 10_000 },
    );
    await popupPage
      .locator("#adsSkippedCount")
      .filter({ hasText: "1" })
      .waitFor({ state: "visible" });
    const fixtureCount = Number(
      await popupPage.locator("#adsSkippedCount").textContent(),
    );
    if (
      initialCount !== CONTRACT.initialCount ||
      fixtureCount !== CONTRACT.fixtureCount ||
      fixtureFulfillments !== 1
    ) {
      throw new Error("offline fixture did not satisfy the capture contract");
    }
    const handledFixturePath = path.join(
      workflowDir,
      "fixture-handled.png",
    );
    await fixturePage.screenshot({
      animations: "disabled",
      path: handledFixturePath,
    });
    const finalPopupPath = path.join(workflowDir, "popup-final.png");
    const finalPopup = await popupPage.locator("body").screenshot({
      animations: "disabled",
      path: finalPopupPath,
    });
    await writeFile(
      path.join(ASSET_DIR, "popup-offline-fixture.png"),
      finalPopup,
    );

    const workflowPage = await context.newPage();
    const workflowFrames = [
      {
        boundary: "Chromium 140 · fresh profile · count read from storage",
        detail:
          "The actual packaged popup starts from durable local state.",
        imagePath: initialPopupPath,
        step: "01 / 03",
        title: "Fresh profile",
      },
      {
        boundary:
          "One local HTTPS fulfillment · every other HTTP(S) request aborted",
        detail:
          "The real content script clicks the fixture control and reports one exact message.",
        imagePath: handledFixturePath,
        step: "02 / 03",
        title: "Boundary exercised",
      },
      {
        boundary:
          "Content script → MV3 worker → trusted local storage → popup",
        detail:
          "The same unpacked extension popup observes the durable count change.",
        imagePath: finalPopupPath,
        step: "03 / 03",
        title: "Count 0 → 1",
      },
    ];
    const workflowFramePaths = [];
    for (const [index, frame] of workflowFrames.entries()) {
      const outputPath = path.join(
        workflowDir,
        `workflow-${String(index + 1).padStart(2, "0")}.png`,
      );
      await renderWorkflowFrame(workflowPage, frame, outputPath);
      workflowFramePaths.push(outputPath);
    }
    await encodeWorkflowGif(workflowFramePaths);

    const transcriptPage = await context.newPage();
    await transcriptPage.setViewportSize({ width: 1120, height: 640 });
    await transcriptPage.setContent(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; }
            body {
              width: 1120px;
              height: 640px;
              margin: 0;
              padding: 48px;
              background: #090d16;
              color: #e2e8f0;
              font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            }
            .eyebrow {
              margin: 0 0 14px;
              color: #f87171;
              font: 700 13px system-ui, sans-serif;
              letter-spacing: 2px;
              text-transform: uppercase;
            }
            pre {
              margin: 0;
              padding: 30px;
              border: 1px solid #334155;
              border-radius: 18px;
              background: #111827;
              box-shadow: 0 18px 50px rgb(0 0 0 / 30%);
              font-size: 16px;
              line-height: 1.65;
              white-space: pre;
            }
          </style>
        </head>
        <body>
          <p class="eyebrow">PRODUCTION FUNCTION OUTPUT · DETERMINISTIC INPUTS</p>
          <pre>${escapeHtml(policyTranscript)}</pre>
        </body>
      </html>`);
    await transcriptPage.screenshot({
      animations: "disabled",
      path: path.join(ASSET_DIR, "policy-matrix.png"),
    });

    return {
      chromium: context.browser().version(),
      containerImage: CONTRACT.containerImage,
      networkMode: CONTRACT.networkMode,
      networkBoundary,
      extensionIdDerivedFromWorker: true,
      initialCount,
      fixtureCount,
      fixtureFulfillments,
      fixtureUrl: FIXTURE_URL,
      playwright: playwrightVersion,
      workflowGif: {
        delaysMs: WORKFLOW_GIF.delaysMs,
        frameCount: workflowFramePaths.length,
        framePixelSha256: WORKFLOW_GIF.framePixelSha256,
        height: WORKFLOW_GIF.height,
        width: WORKFLOW_GIF.width,
      },
    };
  } finally {
    await context.close();
  }
}

async function buildEvidenceManifest(browserEvidence) {
  const testInputs = (await readdir(path.join(ROOT, "test")))
    .filter((entry) => entry.endsWith(".test.js"))
    .sort()
    .map((entry) => `test/${entry}`);
  const inputs = [...CONTRACT.staticInputs, ...testInputs].sort();
  const outputs = CONTRACT.outputs;
  const describeFiles = async (files) =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await sha256(path.join(ROOT, file)),
        ]),
      ),
    );

  return {
    schemaVersion: 1,
    browserEvidence,
    capturePolicy: {
      network:
        "The digest-pinned Docker capture required a loopback-only namespace with no IPv4 default route; one HTTPS fixture request was fulfilled locally by Playwright routing.",
      popup:
        "Real unpacked-extension popup observed at count 0, then count 1 after the real content script and service worker processed one offline DOM-contract fixture.",
      workflowGif:
        "Three annotated frames are composed from the actual fresh popup, handled offline fixture, and updated popup screenshots captured in the same Chromium session.",
      policyMatrix:
        "Rendered from the exact transcript computed by content.js::choosePlaybackRate.",
      provenance:
        "This manifest is a reproducibility and drift contract produced by audited repository scripts; it is not cryptographic attestation of the host or container operator.",
    },
    inputs: await describeFiles(inputs),
    outputs: await describeFiles(outputs),
    toolchain: {
      node: process.version,
      playwright: playwrightVersion,
    },
  };
}

async function main() {
  await mkdir(ASSET_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  await normalizeIcon();
  const policyTranscript = buildPolicyTranscript();
  await writeFile(
    path.join(EVIDENCE_DIR, "policy-matrix.txt"),
    `${policyTranscript}\n`,
  );
  await writeFile(
    path.join(ASSET_DIR, "architecture.svg"),
    buildArchitectureSvg(),
  );
  await writeFile(
    path.join(ASSET_DIR, "setup-flow.svg"),
    buildSetupSvg(),
  );

  const coverage = await runCoverage();
  await writeFile(
    path.join(EVIDENCE_DIR, "coverage-summary.json"),
    `${JSON.stringify({ schemaVersion: 1, coverage }, null, 2)}\n`,
  );
  await writeFile(
    path.join(ASSET_DIR, "coverage.svg"),
    buildCoverageSvg(coverage),
  );

  const browserEvidence = await captureBrowserVisuals(policyTranscript);
  const manifest = await buildEvidenceManifest(browserEvidence);
  await writeFile(
    path.join(EVIDENCE_DIR, "visual-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  process.stdout.write(
    `captured ${Object.keys(manifest.outputs).length} verified outputs\n`,
  );
}

await main();
