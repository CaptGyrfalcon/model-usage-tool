const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { build, drawIcon } = require("../scripts/build-app-icon.cjs");

test("app icon pixels are opaque bars, not an empty tile", () => {
  const rgba = drawIcon(32);
  let opaque = 0, colored = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 200) opaque++;
    if (rgba[i + 3] > 200 && (rgba[i] > 80 || rgba[i + 1] > 80 || rgba[i + 2] > 80)) colored++;
  }
  assert.ok(opaque > 32 * 32 * 0.4, "rounded tile fills most of the icon");
  assert.ok(colored > 40, "usage bars are visible against the dark tile");
});

test("checked-in icon files are real PNG and ICO payloads", () => {
  const { png, ico } = build(path.join(__dirname, "../src/assets"));
  const pngBytes = fs.readFileSync(png);
  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(pngBytes.length > 200);
  const icoBytes = fs.readFileSync(ico);
  assert.equal(icoBytes.readUInt16LE(0), 0);
  assert.equal(icoBytes.readUInt16LE(2), 1);
  assert.ok(icoBytes.readUInt16LE(4) >= 3);
});
