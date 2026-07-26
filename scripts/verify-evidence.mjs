import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pngjs from "pngjs";

import { decodeGifEvidence } from "./gif-evidence.mjs";

const { PNG } = pngjs;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const ROOT_REAL = await realpath(ROOT);
const MANIFEST_PATH = path.join(
  ROOT,
  "docs",
  "evidence",
  "visual-manifest.json",
);
const CONTRACT_PATH = path.join(SCRIPT_DIR, "visual-contract.json");
const EXPECTED_WRAPPER_SHA256 =
  "12b63f622d733167d30fd44a25fee9955162fa078d7a1c054ebe72f63e192ceb";
const EXPECTED_CONTRACT = {
  schemaVersion: 1,
  containerImage:
    "mcr.microsoft.com/playwright:v1.55.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c",
  networkMode: "none",
  networkInterfaces: ["lo"],
  defaultRoutePresent: false,
  fixtureUrl:
    "https://www.youtube.com/watch?v=ytas-offline-contract-fixture",
  initialCount: 0,
  fixtureCount: 1,
  chromium: "140.0.7339.186",
  node: "v22.19.0",
  playwright: "1.55.1",
  workflowGif: {
    width: 960,
    height: 540,
    frameCount: 3,
    delaysMs: [1600, 1900, 2400],
    framePixelSha256: [
      "6dc8b409c2dc8e32c313c6fd6ea052a94288ece8cc4939797437848e7e177407",
      "527abf3a27fc69a73327d49f483a4b21d3f26b18adeb6a57089526a66950ab48",
      "1b66fcad5f997b757b097c23c45d52ab0977664dd72d30a5908b2c254508bf39",
    ],
  },
  staticInputs: [
    "README.md",
    "background.js",
    "content.js",
    "images/icon126-source.png",
    "images/icon16.png",
    "images/icon48.png",
    "manifest.json",
    "package-lock.json",
    "package.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "scripts/capture-visuals-docker.sh",
    "scripts/capture-visuals.mjs",
    "scripts/gif-evidence.mjs",
    "scripts/promote-visuals.mjs",
    "scripts/verify-evidence.mjs",
    "scripts/visual-contract.json",
  ],
  outputs: [
    "docs/assets/architecture.svg",
    "docs/assets/coverage.svg",
    "docs/assets/offline-workflow.gif",
    "docs/assets/policy-matrix.png",
    "docs/assets/popup-offline-fixture.png",
    "docs/assets/setup-flow.svg",
    "docs/evidence/coverage-summary.json",
    "docs/evidence/policy-matrix.txt",
    "images/icon128.png",
  ],
};

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertSafeRelativePath(file) {
  if (
    typeof file !== "string" ||
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").includes("..")
  ) {
    throw new Error(`unsafe evidence path: ${file}`);
  }
}

async function resolveRegularFile(file) {
  assertSafeRelativePath(file);
  let cursor = ROOT;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`evidence path contains a symlink: ${file}`);
    }
  }
  const stat = await lstat(cursor);
  if (!stat.isFile()) {
    throw new Error(`evidence path is not a regular file: ${file}`);
  }
  const resolved = await realpath(cursor);
  if (!resolved.startsWith(`${ROOT_REAL}${path.sep}`)) {
    throw new Error(`evidence path escapes the repository: ${file}`);
  }
  return cursor;
}

async function verifyFiles(files, label) {
  for (const [file, expected] of Object.entries(files)) {
    const actual = await sha256(await resolveRegularFile(file));
    if (
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`${label} drift: ${file}`);
    }
  }
}

async function verifySafePngChunks(file) {
  const bytes = await readFile(await resolveRegularFile(file));
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`${file} is not a PNG`);
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new Error(`${file} has a truncated PNG chunk`);
    }
    chunks.push(bytes.toString("ascii", offset + 4, offset + 8));
    offset = end;
  }
  if (
    offset !== bytes.length ||
    chunks[0] !== "IHDR" ||
    chunks.at(-1) !== "IEND" ||
    chunks.some((chunk) => !["IHDR", "IDAT", "IEND"].includes(chunk))
  ) {
    throw new Error(`${file} contains unexpected PNG metadata or chunks`);
  }
}

async function verifyPng(file, width, height = null) {
  await verifySafePngChunks(file);
  const image = PNG.sync.read(await readFile(await resolveRegularFile(file)));
  if (image.width !== width || (height !== null && image.height !== height)) {
    throw new Error(
      `${file} dimensions ${image.width}×${image.height} do not match evidence contract`,
    );
  }
}

async function verifyGif(file, expected) {
  const bytes = await readFile(await resolveRegularFile(file));
  if (bytes.length > 5_000_000) {
    throw new Error(`${file} exceeds the evidence size ceiling`);
  }

  const decoded = decodeGifEvidence(bytes);
  if (
    decoded.width !== expected.width ||
    decoded.height !== expected.height ||
    decoded.screenPacked !== 0xf7 ||
    decoded.backgroundColorIndex !== 0 ||
    decoded.pixelAspectRatio !== 0 ||
    decoded.repeat !== 0 ||
    decoded.frames.length !== expected.frameCount
  ) {
    throw new Error(`${file} animation contract drifted`);
  }
  const delaysMs = decoded.frames.map((frame) => frame.delayMs);
  const framePixelSha256 = decoded.frames.map(
    (frame) => frame.pixelSha256,
  );
  if (
    JSON.stringify(delaysMs) !== JSON.stringify(expected.delaysMs) ||
    JSON.stringify(framePixelSha256) !==
      JSON.stringify(expected.framePixelSha256)
  ) {
    throw new Error(`${file} timing or decoded pixels drifted`);
  }
  for (const [index, frame] of decoded.frames.entries()) {
    if (
      frame.left !== 0 ||
      frame.top !== 0 ||
      frame.width !== expected.width ||
      frame.height !== expected.height ||
      frame.interlaced ||
      frame.sorted ||
      frame.reservedImageBits !== 0 ||
      frame.localColorTable !== (index !== 0) ||
      frame.minimumCodeSize !== 8 ||
      frame.packed !== 0x04 ||
      frame.disposal !== 1 ||
      frame.userInput ||
      frame.transparent ||
      frame.transparentIndex !== 0
    ) {
      throw new Error(`${file} frame encoding contract drifted`);
    }
  }
}

async function verifyPaddedIcon() {
  const source = PNG.sync.read(
    await readFile(await resolveRegularFile("images/icon126-source.png")),
  );
  const icon = PNG.sync.read(
    await readFile(await resolveRegularFile("images/icon128.png")),
  );
  if (
    source.width !== 126 ||
    source.height !== 126 ||
    icon.width !== 128 ||
    icon.height !== 128
  ) {
    throw new Error("icon padding dimensions are invalid");
  }

  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const targetStart = ((y + 1) * icon.width + 1) * 4;
    if (
      !source.data
        .subarray(sourceStart, sourceStart + source.width * 4)
        .equals(
          icon.data.subarray(targetStart, targetStart + source.width * 4),
        )
    ) {
      throw new Error("128×128 icon does not preserve the legacy pixels");
    }
  }
  for (let index = 0; index < icon.width; index += 1) {
    const alphas = [
      icon.data[(index * 4) + 3],
      icon.data[(((127 * 128) + index) * 4) + 3],
      icon.data[((index * 128) * 4) + 3],
      icon.data[(((index * 128) + 127) * 4) + 3],
    ];
    if (alphas.some(Boolean)) {
      throw new Error("128×128 icon border is not transparent");
    }
  }
}

async function verifySvg(file) {
  const source = await readFile(await resolveRegularFile(file), "utf8");
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  if (
    !source.startsWith(`${declaration}\n<svg `) ||
    !source.includes('xmlns="http://www.w3.org/2000/svg"')
  ) {
    throw new Error(`${file} does not use the exact SVG document boundary`);
  }

  const body = source.slice(declaration.length);
  if (
    /<\?(?!$)|<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY/i.test(body) ||
    /<\/?[A-Za-z][\w.-]*:/i.test(body) ||
    /\b(?:href|src|xlink:[\w.-]+|on[a-z]+|style)\s*=/i.test(body) ||
    /(?:javascript|data|blob|file|https?|ftp):/i.test(
      body.replace('xmlns="http://www.w3.org/2000/svg"', ""),
    ) ||
    /@import|expression\s*\(/i.test(body) ||
    /url\s*\(/i.test(body.replaceAll("url(#arrow)", ""))
  ) {
    throw new Error(`${file} contains an active SVG mechanism`);
  }

  const allowedAttributes = new Map([
    [
      "svg",
      new Set([
        "xmlns",
        "width",
        "height",
        "viewBox",
        "role",
        "aria-labelledby",
      ]),
    ],
    ["title", new Set(["id"])],
    ["desc", new Set(["id"])],
    ["defs", new Set()],
    [
      "marker",
      new Set([
        "id",
        "markerWidth",
        "markerHeight",
        "refX",
        "refY",
        "orient",
        "markerUnits",
      ]),
    ],
    ["path", new Set(["d", "class", "fill"])],
    ["style", new Set()],
    [
      "rect",
      new Set([
        "x",
        "y",
        "width",
        "height",
        "rx",
        "fill",
        "stroke",
        "stroke-width",
      ]),
    ],
    ["text", new Set(["x", "y", "class", "text-anchor"])],
    ["g", new Set()],
    ["circle", new Set(["cx", "cy", "r", "fill"])],
  ]);
  const stack = [];
  const tagPattern =
    /<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>]*?)(\/?)>/g;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(body)) !== null) {
    const nextMarkup = body.indexOf("<", cursor);
    if (nextMarkup !== match.index) {
      throw new Error(`${file} contains unparsed SVG markup`);
    }
    cursor = tagPattern.lastIndex;
    const [, closing, element, attributeSource, selfClosing] = match;
    const allowed = allowedAttributes.get(element);
    if (!allowed) {
      throw new Error(`${file} contains disallowed SVG element ${element}`);
    }
    if (closing) {
      if (attributeSource.trim() || selfClosing) {
        throw new Error(`${file} has a malformed SVG closing tag`);
      }
      if (stack.pop() !== element) {
        throw new Error(`${file} has unbalanced SVG elements`);
      }
      continue;
    }

    const seen = new Set();
    let attributeCursor = 0;
    while (attributeCursor < attributeSource.length) {
      const whitespace = attributeSource
        .slice(attributeCursor)
        .match(/^\s+/);
      if (whitespace) {
        attributeCursor += whitespace[0].length;
      }
      if (attributeCursor === attributeSource.length) {
        break;
      }
      const attribute = attributeSource
        .slice(attributeCursor)
        .match(/^([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/);
      if (!attribute) {
        throw new Error(`${file} has an unparsed SVG attribute`);
      }
      const [, name, value] = attribute;
      if (!allowed.has(name) || seen.has(name)) {
        throw new Error(
          `${file} has disallowed or duplicate ${element}.${name}`,
        );
      }
      if (
        (element === "svg" &&
          name === "xmlns" &&
          value !== "http://www.w3.org/2000/svg") ||
        /[<>]/.test(value)
      ) {
        throw new Error(`${file} has an unsafe SVG attribute value`);
      }
      seen.add(name);
      attributeCursor += attribute[0].length;
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }
  if (
    body.indexOf("<", cursor) !== -1 ||
    stack.length !== 0 ||
    !body.trimEnd().endsWith("</svg>")
  ) {
    throw new Error(`${file} is not a balanced allowlisted SVG document`);
  }
}

async function main() {
  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  assert.deepStrictEqual(
    contract,
    EXPECTED_CONTRACT,
    "visual capture contract drift",
  );

  const wrapper = await sha256(
    await resolveRegularFile("scripts/capture-visuals-docker.sh"),
  );
  if (wrapper.sha256 !== EXPECTED_WRAPPER_SHA256) {
    throw new Error("Docker capture boundary drift");
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.schemaVersion !== 1) {
    throw new Error("unsupported visual evidence schema");
  }
  assert.deepStrictEqual(
    manifest.browserEvidence,
    {
      chromium: EXPECTED_CONTRACT.chromium,
      containerImage: EXPECTED_CONTRACT.containerImage,
      networkMode: EXPECTED_CONTRACT.networkMode,
      networkBoundary: {
        interfaceNames: EXPECTED_CONTRACT.networkInterfaces,
        nonLoopbackAddressCount: 0,
        defaultRoutePresent: EXPECTED_CONTRACT.defaultRoutePresent,
      },
      extensionIdDerivedFromWorker: true,
      initialCount: EXPECTED_CONTRACT.initialCount,
      fixtureCount: EXPECTED_CONTRACT.fixtureCount,
      fixtureFulfillments: 1,
      fixtureUrl: EXPECTED_CONTRACT.fixtureUrl,
      playwright: EXPECTED_CONTRACT.playwright,
      workflowGif: {
        delaysMs: EXPECTED_CONTRACT.workflowGif.delaysMs,
        frameCount: EXPECTED_CONTRACT.workflowGif.frameCount,
        framePixelSha256:
          EXPECTED_CONTRACT.workflowGif.framePixelSha256,
        height: EXPECTED_CONTRACT.workflowGif.height,
        width: EXPECTED_CONTRACT.workflowGif.width,
      },
    },
    "browser evidence contract drift",
  );
  assert.deepStrictEqual(
    manifest.toolchain,
    {
      node: EXPECTED_CONTRACT.node,
      playwright: EXPECTED_CONTRACT.playwright,
    },
    "visual toolchain drift",
  );
  if (
    !manifest.capturePolicy?.provenance?.includes(
      "not cryptographic attestation",
    )
  ) {
    throw new Error("visual provenance limitation is missing");
  }

  const packageJson = JSON.parse(
    await readFile(await resolveRegularFile("package.json"), "utf8"),
  );
  const packageLock = JSON.parse(
    await readFile(await resolveRegularFile("package-lock.json"), "utf8"),
  );
  if (
    packageJson.devDependencies?.gifenc !== "1.0.3" ||
    packageJson.devDependencies?.playwright !==
      EXPECTED_CONTRACT.playwright ||
    packageJson.devDependencies?.pngjs !== "7.0.0" ||
    packageLock.packages?.["node_modules/playwright"]?.version !==
      EXPECTED_CONTRACT.playwright ||
    packageLock.packages?.["node_modules/pngjs"]?.version !== "7.0.0" ||
    packageLock.packages?.["node_modules/gifenc"]?.version !== "1.0.3"
  ) {
    throw new Error("visual dependency pins drift");
  }

  const currentTests = (await readdir(path.join(ROOT, "test")))
    .filter((entry) => entry.endsWith(".test.js"))
    .sort()
    .map((entry) => `test/${entry}`);
  const requiredInputs = [
    ...EXPECTED_CONTRACT.staticInputs,
    ...currentTests,
  ].sort();
  if (
    JSON.stringify(Object.keys(manifest.inputs).sort()) !==
    JSON.stringify(requiredInputs)
  ) {
    throw new Error("visual input set does not match the contract");
  }
  if (
    JSON.stringify(Object.keys(manifest.outputs).sort()) !==
    JSON.stringify([...EXPECTED_CONTRACT.outputs].sort())
  ) {
    throw new Error("visual output set does not match the contract");
  }

  await verifyFiles(manifest.inputs, "visual input");
  await verifyFiles(manifest.outputs, "visual output");
  await verifyPng("images/icon128.png", 128, 128);
  await verifyPaddedIcon();
  await verifyGif(
    "docs/assets/offline-workflow.gif",
    EXPECTED_CONTRACT.workflowGif,
  );
  await verifyPng("docs/assets/popup-offline-fixture.png", 336);
  await verifyPng("docs/assets/policy-matrix.png", 1120, 640);
  await verifySvg("docs/assets/architecture.svg");
  await verifySvg("docs/assets/coverage.svg");
  await verifySvg("docs/assets/setup-flow.svg");

  process.stdout.write(
    `verified ${Object.keys(manifest.outputs).length} visual outputs\n`,
  );
}

await main();
