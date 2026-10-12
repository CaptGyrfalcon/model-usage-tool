const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ReceiptModel = require("../src/renderer/receipt-model.js");

function workerRuntime({ encodeError = null } = {}) {
  const canvases = [], messages = [];
  class OffscreenCanvas {
    constructor(width, height) {
      this.width = width; this.height = height; this.requests = [];
      this.context = new Proxy({
        measureText: text => ({ width: text.length * 18 }),
        createLinearGradient: () => ({ addColorStop() {} }),
      }, { get: (target, key) => target[key] ?? (() => {}) });
      canvases.push(this);
    }
    getContext(type, options) { this.requests.push({ type, options }); return this.context; }
    async convertToBlob({ type }) {
      if (encodeError) throw encodeError;
      return { type, width: this.width, height: this.height };
    }
    transferToImageBitmap() { return { width: this.width, height: this.height }; }
  }
  const context = vm.createContext({ ReceiptModel, OffscreenCanvas, importScripts() {},
    self: { postMessage(data, transfers) { messages.push({ data, transfers }); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/renderer/receipt-worker.js"), "utf8"), context);
  return { canvases, messages, run: payload => context.self.onmessage({ data: payload }) };
}

test("long receipts use CPU canvases, bound UI textures, and export every row at original resolution", async () => {
  const worker = workerRuntime();
  const data = ReceiptModel.build(Array.from({ length: 120 }, (_, i) => ({
    source: "devin", model: `swe-2-${i}`, count: 1, costCents: i,
  })), { date: "2026-10-11", splitEffort: false, splitSpeed: false });
  let logoClosed = false;
  await worker.run({ receipt: data, logos: { devin: { close() { logoClosed = true; } } } });
  const { data: result, transfers } = worker.messages[0];
  assert.equal(worker.canvases.length, 2);
  for (const canvas of worker.canvases) {
    assert.equal(canvas.requests[0].type, "2d");
    assert.equal(canvas.requests[0].options?.willReadFrequently, true, "avoid the window's shared GPU queue");
  }
  assert.ok(result.bitmap.width <= 780);
  assert.ok(result.bitmap.height <= 8192);
  assert.ok(result.bitmap.width * result.bitmap.height <= 4_000_000);
  assert.equal(result.png.type, "image/png");
  assert.equal(result.png.width, 1390);
  assert.ok(result.png.height > 8192);
  assert.equal(transfers[0], result.bitmap);
  assert.equal(result.plain.split("\n").filter(line => line.startsWith("SWE 2")).length, 120);
  assert.equal(logoClosed, true);
});

test("worker PNG encoding failures release logos and return a recoverable error", async () => {
  const worker = workerRuntime({ encodeError: new Error("PNG failed") });
  let logoClosed = false;
  await worker.run({ receipt: ReceiptModel.build([], { date: "2026-10-11" }),
    logos: { devin: { close() { logoClosed = true; } } } });
  assert.equal(worker.messages[0].data.error, "PNG failed");
  assert.equal(worker.messages[0].data.bitmap, undefined);
  assert.equal(logoClosed, true);
});
