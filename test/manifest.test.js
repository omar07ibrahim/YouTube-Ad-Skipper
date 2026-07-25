"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);

test("manifest uses one least-privilege static content script", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_security_policy" in manifest, false);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://www.youtube.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
  assert.equal(manifest.content_scripts[0].run_at, "document_idle");
});

test("all local files referenced by the manifest exist", () => {
  const referenced = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];

  for (const relativePath of new Set(referenced)) {
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      true,
      `${relativePath} must exist`,
    );
  }
});

test("popup references only existing packaged scripts, styles, and images", () => {
  const popup = fs.readFileSync(
    path.join(root, manifest.action.default_popup),
    "utf8",
  );
  const localAssets = [
    ...Array.from(
      popup.matchAll(/<(?:img|script)\b[^>]*\bsrc="([^"]+)"/gi),
      (match) => match[1],
    ),
    ...Array.from(
      popup.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi),
      (match) => match[1],
    ),
  ];

  for (const relativePath of localAssets) {
    assert.doesNotMatch(relativePath, /^https?:/);
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      true,
      `${relativePath} must exist`,
    );
  }
});

test("background has no programmatic reinjection path", () => {
  const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.equal(source.includes("tabs.onUpdated"), false);
  assert.equal(source.includes("scripting.executeScript"), false);
});
