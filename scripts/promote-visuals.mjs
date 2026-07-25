import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const CONTRACT = JSON.parse(
  await readFile(path.join(SCRIPT_DIR, "visual-contract.json"), "utf8"),
);
const MANIFEST_FILE = "docs/evidence/visual-manifest.json";

function assertSafeRelativePath(file) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").includes("..")
  ) {
    throw new Error(`unsafe promotion path: ${file}`);
  }
}

async function resolveRegularFile(root, file) {
  assertSafeRelativePath(file);
  let cursor = root;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`promotion path contains a symlink: ${file}`);
    }
  }
  const stat = await lstat(cursor);
  if (!stat.isFile()) {
    throw new Error(`promotion path is not a regular file: ${file}`);
  }
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(cursor);
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`promotion path escapes its root: ${file}`);
  }
  return cursor;
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameDescription(left, right) {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

async function assertSafeTargetParent(file) {
  assertSafeRelativePath(file);
  const parentParts = path.dirname(file).split("/");
  let cursor = ROOT;
  for (const part of parentParts) {
    cursor = path.join(cursor, part);
    await mkdir(cursor, { recursive: true });
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`promotion target parent is unsafe: ${file}`);
    }
  }
  const target = path.join(ROOT, file);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`promotion target is unsafe: ${file}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return target;
}

async function main() {
  const stageRoot = path.resolve(process.argv[2] || "");
  if (!process.argv[2] || stageRoot === ROOT) {
    throw new Error("provide the isolated visual-capture root");
  }

  const stageManifestPath = await resolveRegularFile(
    stageRoot,
    MANIFEST_FILE,
  );
  const manifest = JSON.parse(await readFile(stageManifestPath, "utf8"));
  const testInputs = (await readdir(path.join(ROOT, "test"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => `test/${entry.name}`);
  const requiredInputs = [...CONTRACT.staticInputs, ...testInputs].sort();
  const manifestInputs = Object.keys(manifest.inputs).sort();
  if (JSON.stringify(manifestInputs) !== JSON.stringify(requiredInputs)) {
    throw new Error("staged visual input set does not match the contract");
  }
  const manifestOutputs = Object.keys(manifest.outputs).sort();
  const contractOutputs = [...CONTRACT.outputs].sort();
  if (JSON.stringify(manifestOutputs) !== JSON.stringify(contractOutputs)) {
    throw new Error("staged visual output set does not match the contract");
  }

  for (const [file, expected] of Object.entries(manifest.inputs)) {
    const stagedPath = await resolveRegularFile(stageRoot, file);
    const currentPath = await resolveRegularFile(ROOT, file);
    const [staged, current] = await Promise.all([
      sha256(stagedPath),
      sha256(currentPath),
    ]);
    if (
      !sameDescription(staged, expected) ||
      !sameDescription(current, expected)
    ) {
      throw new Error(`capture input changed before promotion: ${file}`);
    }
  }

  for (const [file, expected] of Object.entries(manifest.outputs)) {
    const stagedPath = await resolveRegularFile(stageRoot, file);
    const actual = await sha256(stagedPath);
    if (!sameDescription(actual, expected)) {
      throw new Error(`staged visual output drift: ${file}`);
    }
  }

  const files = [...CONTRACT.outputs, MANIFEST_FILE];
  const pending = [];
  try {
    for (const file of files) {
      const source = await resolveRegularFile(stageRoot, file);
      const target = await assertSafeTargetParent(file);
      const temporary = `${target}.ytas-promote-${randomUUID()}`;
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      pending.push({ target, temporary });
    }
    for (const { target, temporary } of pending) {
      await rename(temporary, target);
    }
  } finally {
    await Promise.all(
      pending.map(({ temporary }) => rm(temporary, { force: true })),
    );
  }

  process.stdout.write(
    `promoted ${CONTRACT.outputs.length} verified visual outputs\n`,
  );
}

await main();
