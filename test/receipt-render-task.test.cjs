const test = require("node:test");
const assert = require("node:assert/strict");
const createRenderer = require("../src/renderer/receipt-render-task.js");

function runtime() {
  const workers = [], copies = [];
  class Worker {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(payload, transfers) { this.payload = payload; this.transfers = transfers; }
    terminate() { this.terminated = true; }
  }
  const api = createRenderer({ Worker, async createImageBitmap() {
    const copy = { close() { this.closed = true; } }; copies.push(copy); return copy;
  } });
  return { api, workers, copies };
}

test("changing receipt rules terminates the old drawing worker and only the latest result survives", async () => {
  const { api, workers, copies } = runtime();
  const old = new AbortController(), latest = new AbortController();
  const first = api.render({ source: "all" }, { devin: {} }, old.signal);
  const canceled = assert.rejects(first, { name: "AbortError" });
  await new Promise(setImmediate);
  const lateMessage = workers[0].onmessage;
  old.abort();
  assert.equal(workers[0].terminated, true);
  const second = api.render({ source: "devin" }, { devin: {} }, latest.signal);
  await new Promise(setImmediate);
  assert.equal(workers[1].payload.receipt.source, "devin");
  assert.equal(workers[1].transfers[0], copies[1]);
  let staleClosed = false;
  lateMessage({ data: { bitmap: { close() { staleClosed = true; } }, plain: "old" } });
  assert.equal(staleClosed, true);
  const bitmap = {};
  workers[1].onmessage({ data: { bitmap, plain: "latest" } });
  assert.deepEqual(await second, { bitmap, plain: "latest" });
  await canceled;
  assert.equal(workers[1].terminated, true);
  assert.ok(copies.every(copy => copy.closed));
});

test("canceling during logo preparation releases resources without starting a drawing worker", async () => {
  const controller = new AbortController();
  let release, closed = false, workerStarted = false;
  const api = createRenderer({
    createImageBitmap: () => new Promise(resolve => { release = resolve; }),
    Worker: class { constructor() { workerStarted = true; } },
  });
  const drawing = api.render({}, { devin: {} }, controller.signal);
  controller.abort();
  release({ close() { closed = true; } });
  await assert.rejects(drawing, { name: "AbortError" });
  assert.equal(closed, true);
  assert.equal(workerStarted, false);
});

test("worker errors release the worker and allow a fresh receipt render", async () => {
  const { api, workers } = runtime();
  const controller = new AbortController();
  const drawing = api.render({}, {}, controller.signal);
  let prevented = false;
  workers[0].onerror({ preventDefault() { prevented = true; } });
  await assert.rejects(drawing, /小票绘制失败/);
  assert.equal(prevented, true);
  assert.equal(workers[0].terminated, true);
  const retry = api.render({}, {}, controller.signal);
  workers[1].onmessage({ data: { plain: "retry", bitmap: {} } });
  assert.equal((await retry).plain, "retry");
});
