const fs = require("node:fs");
const path = require("node:path");
const { crc32, deflateSync } = require("node:zlib");

const MINT = [157, 245, 208];
const INDIGO = [124, 140, 255];
const INK = [23, 26, 35];
const EDGE = [48, 54, 72];
const SIZES = [16, 20, 24, 32, 48, 64];

function mix(from, to, t) {
  return from.map((value, index) => Math.round(value + (to[index] - value) * t));
}

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius + 0.25;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const put = (x, y, rgb, alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    rgba[index] = rgb[0];
    rgba[index + 1] = rgb[1];
    rgba[index + 2] = rgb[2];
    rgba[index + 3] = alpha;
  };
  const pad = Math.max(1, Math.round(size * 0.06));
  const radius = Math.max(2, Math.round(size * 0.22));
  const left = pad, top = pad, right = size - pad - 1, bottom = size - pad - 1;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!inRoundedRect(x, y, left, top, right, bottom, radius)) continue;
      const onEdge = !inRoundedRect(x, y, left + 1, top + 1, right - 1, bottom - 1, Math.max(1, radius - 1));
      put(x, y, onEdge ? EDGE : INK);
    }
  }
  const inner = size - pad * 2;
  const barWidth = Math.max(2, Math.round(inner * 0.16));
  const gap = Math.max(1, Math.round(inner * 0.08));
  const group = barWidth * 3 + gap * 2;
  const startX = Math.round((size - group) / 2);
  const base = bottom - Math.max(1, Math.round(size * 0.12));
  const heights = [0.42, 0.78, 0.58];
  heights.forEach((height, index) => {
    const color = mix(MINT, INDIGO, index / 2);
    const x0 = startX + index * (barWidth + gap);
    const barTop = Math.round(base - inner * height);
    for (let y = barTop; y <= base; y++) {
      for (let x = x0; x < x0 + barWidth; x++) put(x, y, color);
    }
  });
  return rgba;
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload) >>> 0, 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  const parts = [header];
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = image.size >= 256 ? 0 : image.size;
    header[entry + 1] = image.size >= 256 ? 0 : image.size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
    parts.push(image.png);
  });
  return Buffer.concat(parts);
}

function build(outputDirectory = path.join(__dirname, "../src/assets")) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const images = SIZES.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));
  const png64 = images.find((image) => image.size === 64).png;
  const png = path.join(outputDirectory, "app-icon.png");
  const ico = path.join(outputDirectory, "app-icon.ico");
  fs.writeFileSync(png, png64);
  fs.writeFileSync(ico, encodeIco(images));
  return { png, ico, sizes: SIZES };
}

module.exports = { build, drawIcon, encodePng, encodeIco };
if (require.main === module) {
  const result = build();
  console.log(`Wrote ${result.png} and ${result.ico}`);
}
