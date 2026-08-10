import { createHash } from "node:crypto";

const MAX_INPUT_BYTES = 5_000_000;
const MAX_SCREEN_OR_FRAME_PIXELS = 5_000_000;
const MAX_TOTAL_FRAME_PIXELS = 10_000_000;

function fail(message) {
  throw new Error(`invalid GIF evidence: ${message}`);
}

function readSubBlocks(bytes, start) {
  const chunks = [];
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) {
      return {
        bytes: Buffer.concat(chunks),
        offset,
      };
    }
    if (offset + length > bytes.length) {
      fail("truncated data sub-block");
    }
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  fail("unterminated data sub-block sequence");
}

function readPalette(bytes, start, colorCount) {
  const byteLength = colorCount * 3;
  if (start + byteLength > bytes.length) {
    fail("truncated color table");
  }
  return {
    bytes: bytes.subarray(start, start + byteLength),
    offset: start + byteLength,
  };
}

function concatEntry(prefix, suffix) {
  const combined = new Uint8Array(prefix.length + 1);
  combined.set(prefix);
  combined[prefix.length] = suffix;
  return combined;
}

function decodeLzw(data, minimumCodeSize, expectedPixels) {
  if (
    !Number.isInteger(minimumCodeSize) ||
    minimumCodeSize < 2 ||
    minimumCodeSize > 8
  ) {
    fail("unsupported LZW minimum code size");
  }

  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let dictionary;
  let nextCode;
  let codeSize;
  let previous = null;
  let bitOffset = 0;
  let sawClear = false;
  let sawEnd = false;
  const output = [];

  const reset = () => {
    dictionary = new Array(4096);
    for (let index = 0; index < clearCode; index += 1) {
      dictionary[index] = Uint8Array.of(index);
    }
    nextCode = endCode + 1;
    codeSize = minimumCodeSize + 1;
    previous = null;
  };

  const readCode = () => {
    if (bitOffset + codeSize > data.length * 8) {
      return null;
    }
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const absolute = bitOffset + bit;
      code |=
        ((data[absolute >> 3] >> (absolute & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return code;
  };

  reset();
  while (true) {
    const code = readCode();
    if (code === null) {
      break;
    }
    if (code === clearCode) {
      reset();
      sawClear = true;
      continue;
    }
    if (!sawClear) {
      fail("LZW stream does not begin with a clear code");
    }
    if (code === endCode) {
      sawEnd = true;
      break;
    }

    let entry;
    if (code < nextCode && dictionary[code]) {
      entry = dictionary[code];
    } else if (code === nextCode && previous) {
      entry = concatEntry(previous, previous[0]);
    } else {
      fail("LZW stream references an undefined code");
    }

    if (output.length + entry.length > expectedPixels) {
      fail("LZW stream expands beyond the image boundary");
    }
    for (const value of entry) {
      output.push(value);
    }

    if (previous && nextCode < 4096) {
      dictionary[nextCode] = concatEntry(previous, entry[0]);
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
    }
    previous = entry;
  }

  if (!sawEnd) {
    fail("LZW stream has no end-of-information code");
  }
  if (output.length !== expectedPixels) {
    fail("decoded pixel count does not match the image boundary");
  }
  for (let bit = bitOffset; bit < data.length * 8; bit += 1) {
    if (((data[bit >> 3] >> (bit & 7)) & 1) !== 0) {
      fail("LZW stream has non-zero trailing bits");
    }
  }
  return Uint8Array.from(output);
}

function pixelDigest(indices, palette) {
  const pixels = Buffer.alloc(indices.length * 3);
  for (const [position, paletteIndex] of indices.entries()) {
    const source = paletteIndex * 3;
    if (source + 2 >= palette.length) {
      fail("pixel references a color outside its table");
    }
    const target = position * 3;
    pixels[target] = palette[source];
    pixels[target + 1] = palette[source + 1];
    pixels[target + 2] = palette[source + 2];
  }
  return createHash("sha256").update(pixels).digest("hex");
}

export function decodeGifEvidence(input) {
  if (
    !input ||
    !Number.isInteger(input.byteLength) ||
    input.byteLength > MAX_INPUT_BYTES
  ) {
    fail("input exceeds the byte ceiling");
  }
  const bytes = Buffer.from(input);
  if (
    bytes.length < 14 ||
    bytes.toString("ascii", 0, 6) !== "GIF89a"
  ) {
    fail("missing GIF89a header");
  }

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const screenPacked = bytes[10];
  const backgroundColorIndex = bytes[11];
  const pixelAspectRatio = bytes[12];
  if (width === 0 || height === 0) {
    fail("zero-sized logical screen");
  }
  if (width * height > MAX_SCREEN_OR_FRAME_PIXELS) {
    fail("logical screen exceeds the pixel ceiling");
  }

  let offset = 13;
  let globalPalette = null;
  if ((screenPacked & 0x80) !== 0) {
    const colorCount = 1 << ((screenPacked & 0x07) + 1);
    const table = readPalette(bytes, offset, colorCount);
    globalPalette = table.bytes;
    offset = table.offset;
  }

  let pendingControl = null;
  let repeat = null;
  let reachedTrailer = false;
  let totalFramePixels = 0;
  const frames = [];
  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) {
      reachedTrailer = true;
      break;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) {
        fail("truncated extension");
      }
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        if (
          pendingControl !== null ||
          offset + 6 > bytes.length ||
          bytes[offset] !== 4 ||
          bytes[offset + 5] !== 0
        ) {
          fail("malformed or duplicate graphic control extension");
        }
        const packed = bytes[offset + 1];
        pendingControl = {
          packed,
          disposal: (packed >> 2) & 0x07,
          userInput: (packed & 0x02) !== 0,
          transparent: (packed & 0x01) !== 0,
          delayMs: bytes.readUInt16LE(offset + 2) * 10,
          transparentIndex: bytes[offset + 4],
        };
        offset += 6;
        continue;
      }
      if (label === 0xff) {
        if (offset >= bytes.length) {
          fail("truncated application extension");
        }
        const identifierLength = bytes[offset];
        offset += 1;
        if (
          repeat !== null ||
          identifierLength !== 11 ||
          offset + identifierLength > bytes.length ||
          bytes.toString(
            "ascii",
            offset,
            offset + identifierLength,
          ) !== "NETSCAPE2.0"
        ) {
          fail("unexpected application extension");
        }
        offset += identifierLength;
        const extension = readSubBlocks(bytes, offset);
        offset = extension.offset;
        if (
          extension.bytes.length !== 3 ||
          extension.bytes[0] !== 1
        ) {
          fail("malformed loop extension");
        }
        repeat = extension.bytes.readUInt16LE(1);
        continue;
      }
      fail("disallowed metadata extension");
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      fail("invalid image block");
    }
    if (pendingControl === null) {
      fail("image has no graphic control extension");
    }

    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4);
    const frameHeight = bytes.readUInt16LE(offset + 6);
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (frameWidth === 0 || frameHeight === 0) {
      fail("zero-sized image frame");
    }
    const framePixels = frameWidth * frameHeight;
    if (framePixels > MAX_SCREEN_OR_FRAME_PIXELS) {
      fail("image frame exceeds the pixel ceiling");
    }
    totalFramePixels += framePixels;
    if (totalFramePixels > MAX_TOTAL_FRAME_PIXELS) {
      fail("animation exceeds the decoded-pixel ceiling");
    }

    let palette = globalPalette;
    if ((imagePacked & 0x80) !== 0) {
      const colorCount = 1 << ((imagePacked & 0x07) + 1);
      const table = readPalette(bytes, offset, colorCount);
      palette = table.bytes;
      offset = table.offset;
    }
    if (!palette || offset >= bytes.length) {
      fail("image has no color table or LZW code size");
    }

    const minimumCodeSize = bytes[offset];
    offset += 1;
    const imageData = readSubBlocks(bytes, offset);
    offset = imageData.offset;
    const indices = decodeLzw(
      imageData.bytes,
      minimumCodeSize,
      framePixels,
    );
    frames.push({
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      interlaced: (imagePacked & 0x40) !== 0,
      sorted: (imagePacked & 0x20) !== 0,
      reservedImageBits: imagePacked & 0x18,
      localColorTable: (imagePacked & 0x80) !== 0,
      minimumCodeSize,
      pixelSha256: pixelDigest(indices, palette),
      ...pendingControl,
    });
    pendingControl = null;
  }

  if (
    !reachedTrailer ||
    offset !== bytes.length ||
    pendingControl !== null ||
    frames.length === 0
  ) {
    fail("trailing, incomplete, or empty animation");
  }

  return {
    width,
    height,
    screenPacked,
    backgroundColorIndex,
    pixelAspectRatio,
    repeat,
    frames,
  };
}
