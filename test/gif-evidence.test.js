const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const gifenc = require("gifenc");
const decoder = import("../scripts/gif-evidence.mjs");

function onePixelGif() {
  const gif = gifenc.GIFEncoder();
  gif.writeFrame(Uint8Array.of(1), 1, 1, {
    delay: 20,
    dispose: 1,
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    repeat: 0,
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

test("GIF evidence decoder independently reconstructs pixels", async () => {
  const { decodeGifEvidence } = await decoder;
  const decoded = decodeGifEvidence(onePixelGif());

  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.repeat, 0);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].delayMs, 20);
  assert.equal(
    decoded.frames[0].pixelSha256,
    createHash("sha256")
      .update(Buffer.from([255, 255, 255]))
      .digest("hex"),
  );
});

test("GIF evidence decoder rejects a malformed control extension", async () => {
  const { decodeGifEvidence } = await decoder;
  const corrupted = onePixelGif();
  const control = corrupted.indexOf(
    Buffer.from([0x21, 0xf9, 0x04, 0x04]),
  );
  assert.notEqual(control, -1);
  corrupted[control + 2] = 3;

  assert.throws(
    () => decodeGifEvidence(corrupted),
    /graphic control extension/,
  );
});

test("GIF evidence decoder rejects a trailing unmatched control", async () => {
  const { decodeGifEvidence } = await decoder;
  const original = onePixelGif();
  assert.equal(original.at(-1), 0x3b);
  const corrupted = Buffer.concat([
    original.subarray(0, -1),
    Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x01, 0x00, 0x00, 0x00]),
    original.subarray(-1),
  ]);

  assert.throws(
    () => decodeGifEvidence(corrupted),
    /trailing, incomplete, or empty animation/,
  );
});

test("GIF evidence decoder requires an LZW end code", async () => {
  const { decodeGifEvidence } = await decoder;
  const invalid = Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x21, 0xf9, 0x04, 0x04, 0x01, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x01, 0x04, 0x00, 0x3b,
    ]),
  ]);

  assert.throws(
    () => decodeGifEvidence(invalid),
    /end-of-information code/,
  );
});

test("GIF evidence decoder bounds decompression before reading frames", async () => {
  const { decodeGifEvidence } = await decoder;
  const oversized = Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x3b,
    ]),
  ]);

  assert.throws(
    () => decodeGifEvidence(oversized),
    /logical screen exceeds the pixel ceiling/,
  );
});
