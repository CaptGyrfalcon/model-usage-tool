const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { UsageHistory } = require("../src/history.cjs");
const { CodexUsageScanner } = require("../src/codex.cjs");
const { RefreshScheduler } = require("../src/refresh-scheduler.cjs");
const { SourceSnapshotCache } = require("../src/source-snapshot-cache.cjs");
const { DevinUsageScanner, scanDevinUsage } = require("../src/devin.cjs");
const { buildModelBreakdowns } = require("../src/lib.cjs");

class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-refresh-performance-"));
  const closers = [];
  t.after(() => {
    for (const close of closers) close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("widget-refresh-performance-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, close: fn => closers.push(fn) };
}
const event = (key, source = "codex", timestamp = 1000) => ({ source, eventKey: key, timestamp, model: "test", input: 10 });

test("model aggregates follow SQL corrections, rollback and external writes without stale totals", t => {
  const { dir, close } = fixture(t);
  const history = new FixtureHistory(path.join(dir, "history.sqlite"));
  close(() => history.close());
  history.upsertEvents([event("a")]);
  const total = () => buildModelBreakdowns(history.getEvents({ copy: false })).coarse[0].total;
  assert.equal(total(), 10);
  history.db.exec("BEGIN; UPDATE usage_events SET input_tokens=20");
  assert.equal(total(), 20);
  history.db.exec("ROLLBACK");
  assert.equal(total(), 10);
  const external = new DatabaseSync(history.dbPath);
  try { external.exec("UPDATE usage_events SET input_tokens=30"); }
  finally { external.close(); }
  assert.equal(total(), 30);
  history.db.exec("UPDATE usage_events SET model='corrected',fast=1");
  const updated = buildModelBreakdowns(history.getEvents({ copy: false }));
  assert.equal(updated.exact[0].name, "corrected");
  assert.equal(updated.exact[0].fast, true);
});

test("history caches reused ranges and unrelated writes, but observes changes, rollback and external SQL", t => {
  const { dir, close } = fixture(t);
  const history = new FixtureHistory(path.join(dir, "history.sqlite"));
  close(() => history.close());
  history.upsertEvents([event("a"), event("b", "cursor", 2000)]);
  let reads = 0;
  const original = history.readEvents.bind(history);
  history.readEvents = (...args) => { reads++; return original(...args); };
  const first = history.getEvents({ sources: "codex", end: 1500 });
  first[0].input = 999;
  assert.equal(history.getEvents({ sources: "codex", start: 500, end: 3000 })[0].input, 10);
  assert.equal(reads, 1);
  const shared = history.getEvents({ sources: "codex", copy: false });
  assert.ok(Object.isFrozen(shared[0]));
  assert.equal(shared[0], history.getEvents({ sources: "codex", copy: false })[0]);
  history.upsertEvents([event("b", "cursor", 2000)]);
  history.saveCache("unrelated", { value: 1 });
  history.getEvents({ sources: "codex" });
  assert.equal(reads, 1);
  history.db.exec("BEGIN; UPDATE usage_events SET input_tokens=20 WHERE source='codex'");
  assert.equal(history.getEvents({ sources: "codex" })[0].input, 20);
  history.db.exec("ROLLBACK");
  assert.equal(history.getEvents({ sources: "codex" })[0].input, 10);
  // A later transaction with the same row count must not resurrect a rolled-back cache.
  history.db.exec("UPDATE usage_events SET input_tokens=30 WHERE source='codex'");
  assert.equal(history.getEvents({ sources: "codex" })[0].input, 30);
  const external = new DatabaseSync(history.dbPath);
  try { external.exec("UPDATE usage_events SET input_tokens=40 WHERE source='codex'"); }
  finally { external.close(); }
  assert.equal(history.getEvents({ sources: "codex" })[0].input, 40);
  history.db.exec("DELETE FROM usage_events WHERE source='codex'");
  assert.equal(history.getEvents({ sources: "codex" }).length, 0);
});

test("quota caches retain fractional/zero values, observe quality changes and the provenance switch", t => {
  const history = new FixtureHistory(":memory:");
  t.after(() => history.close());
  history.saveQuotaSample({ source: "codex", pool: "primary-300", timestamp: 1000, usedPercent: 99 });
  history.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp: 1000, usedPercent: 0 });
  let reads = 0;
  const original = history.readQuotaSamples.bind(history);
  history.readQuotaSamples = (...args) => { reads++; return original(...args); };
  assert.equal(history.getQuotaSamples({ source: "codex" })[0].usedPercent, 99);
  history.saveCache("codex-provenance-samples-v1", { at: 1 });
  assert.equal(history.getQuotaSamples({ source: "codex" }).length, 0);
  history.saveQuotaSample({ source: "codex", pool: "primary-300", timestamp: 2000,
    usedPercent: 0.25, windowMinutes: 300, resetsAt: 18002000, sampleKey: "test:1", origin: "session", quality: "valid" });
  assert.equal(history.getQuotaSamples({ source: "codex", end: 3000 })[0].usedPercent, 0.25);
  const before = reads;
  history.getQuotaSamples({ source: "codex", start: 1500, end: 4000 });
  history.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp: 2000, usedPercent: 12.5 });
  history.getQuotaSamples({ source: "codex" });
  assert.equal(reads, before);
  history.db.exec("UPDATE codex_quota_observations SET quality='conflicting-timestamp'");
  assert.equal(history.getQuotaSamples({ source: "codex" }).length, 0);
  assert.equal(history.getQuotaSamples({ source: "codex", includeUnreliable: true }).length, 1);
});

test("pricing snapshots are decoded once and invalidated by real SQL changes", t => {
  const history = new FixtureHistory(":memory:");
  t.after(() => history.close());
  const id = history.savePricingSnapshot({ fetchedAt: 1, status: "test", models: { test: { input: 1 } } });
  let reads = 0;
  const original = history.readPricingSnapshot.bind(history);
  history.readPricingSnapshot = (...args) => { reads++; return original(...args); };
  for (let i = 0; i < 300; i++) assert.equal(history.pricingSnapshot(id).models.test.input, 1);
  assert.equal(reads, 1);
  history.db.prepare("UPDATE pricing_snapshots SET data_json=? WHERE id=?")
    .run(JSON.stringify({ models: { test: { input: 2 } } }), id);
  assert.equal(history.pricingSnapshot(id).models.test.input, 2);
});

test("Codex log scans import full history once, append only new rows, retain quota and recover reused IDs", t => {
  const { dir, close } = fixture(t);
  const db = new DatabaseSync(path.join(dir, "logs_2.sqlite"));
  close(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)");
  const base = 1800000000;
  const add = db.prepare("INSERT INTO logs(ts,thread_id,target,feedback_log_body) VALUES (?,?,?,?)");
  const quota = (used) => JSON.stringify({ "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-used-percent": String(used), "x-codex-primary-reset-at": String(base + 604800) });
  db.exec("BEGIN");
  for (let i = 0; i < 600; i++) add.run(base + i, "s", "codex_http_client::client", quota(i % 100));
  add.run(base, "s", "codex_core::session::handlers", 'service_tier: Some(Some("priority"))');
  db.exec("COMMIT");
  const scanner = new CodexUsageScanner(dir, { fullHistory: true });
  const first = scanner.scan();
  assert.equal(first.quotaSamples.length, 600);
  const second = scanner.scan();
  assert.equal(second.quotaSamples.length, 0);
  assert.deepEqual(second.rateLimit, first.rateLimit);
  assert.equal(scanner.tierAt("s", base * 1000).fast, true);
  db.exec("BEGIN");
  for (let i = 0; i < 550; i++) add.run(base + 600 + i, "s", "codex_http_client::client", quota(0));
  add.run(base + 600, "s", "codex_core::session::handlers", "service_tier: Some(None)");
  db.exec("COMMIT");
  const appended = scanner.scan();
  assert.equal(appended.quotaSamples.length, 550);
  assert.equal(appended.rateLimit.primary.usedPercent, 0);
  assert.equal(scanner.tierAt("s", (base + 600) * 1000).fast, false);
  assert.equal(scanner.scan().quotaSamples.length, 0);
  db.exec("DELETE FROM logs");
  add.run(base + 2000, "s", "codex_http_client::client", quota(12.5));
  const replaced = scanner.scan();
  assert.equal(replaced.quotaSamples.length, 1);
  assert.equal(replaced.rateLimit.primary.usedPercent, 12.5);
  assert.equal(scanner.tierAt("s", (base + 2000) * 1000), null);
});

test("partial source refreshes preserve untouched sample times and retry failures on full refresh", async () => {
  const cache = new SourceSnapshotCache();
  const calls = { codex: 0, cursor: 0, devin: 0 };
  let fail = false;
  const builders = Object.fromEntries(Object.keys(calls).map(source => [source, () => {
    calls[source]++;
    if (source === "devin" && fail) throw new Error("synthetic failure");
    return { source, fetchedAt: calls[source] };
  }]));
  const first = await cache.collect(builders, { sources: ["codex"], pricingKey: "one" });
  const second = await cache.collect(builders, { sources: ["codex"], pricingKey: "one" });
  assert.deepEqual(calls, { codex: 2, cursor: 1, devin: 1 });
  assert.deepEqual(second[1], first[1]);
  assert.equal(second[1].value.fetchedAt, 1);
  fail = true;
  assert.equal((await cache.collect(builders, { sources: ["devin"], pricingKey: "one" }))[2].status, "rejected");
  fail = false;
  assert.equal((await cache.collect(builders, { pricingKey: "one" }))[2].status, "fulfilled");
  const previous = { ...calls };
  await cache.collect(builders, { sources: ["codex"], pricingKey: "two" });
  for (const source of Object.keys(calls)) assert.equal(calls[source], previous[source] + 1);
});

test("incremental Devin scans skip unchanged files, detect edited requests, deduplicate forks and retry failed reads", t => {
  const { dir, close } = fixture(t);
  const file = path.join(dir, "sessions.db");
  const db = new DatabaseSync(file);
  close(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,chat_message TEXT,created_at INTEGER)");
  const message = (id, output = 10) => JSON.stringify({ role: "assistant", message_id: "synthetic-message",
    content: "synthetic private text", metadata: { request_id: id, generation_model: "swe-2-high", created_at: "2026-10-10T12:00:00Z",
      metrics: { input_tokens: 100, output_tokens: output } } });
  const insert = db.prepare("INSERT INTO message_nodes(chat_message,created_at) VALUES (?,?)");
  insert.run(message("one"), 1791633600);
  let reads = 0, fail = false;
  const scanner = new DevinUsageScanner(file, () => {
    reads++;
    return fail ? { events: [], files: 1, scanErrors: ["synthetic failure"] } : scanDevinUsage(file);
  });
  assert.equal(scanner.scan().events.length, 1);
  assert.equal(scanner.scan().events.length, 0);
  assert.equal(reads, 1);
  db.prepare("UPDATE message_nodes SET chat_message=? WHERE row_id=1").run(message("one", 20));
  assert.equal(scanner.scan().events[0].output, 20);
  insert.run(message("one", 20), 1791633600);
  assert.equal(scanner.scan().events.length, 0);
  insert.run(message("two"), 1791633600);
  fail = true;
  assert.equal(scanner.scan().scanErrors.length, 1);
  fail = false;
  const retried = scanner.scan();
  assert.equal(retried.events.length, 1);
  assert.equal(retried.scanErrors.length, 0);
  assert.doesNotMatch(JSON.stringify(retried), /synthetic private text/);
  assert.equal(scanner.scan().events.length, 0);
});

test("SQLite SHM reader notifications cannot trigger refreshes; WAL changes refresh only Codex", async () => {
  const clock = clockFixture();
  let onChange;
  const calls = [];
  const electron = {
    app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}) },
    ipcMain: { handle() {}, on() {} },
  };
  const file = path.resolve(__dirname, "../src/main.cjs");
  const localRequire = require("node:module").createRequire(file);
  const mockedRequire = name => {
    if (name === "electron") return electron;
    if (name === "node:fs") return { ...fs, watch(_dir, _options, callback) { onChange = callback; return { close() {} }; } };
    if (name === "./lib.cjs") return { loadSettings: () => ({ intervalMs: 15000 }) };
    return localRequire(name);
  };
  const m = { exports: {} };
  const appended = "\nmodule.exports={startCodexWatch,refreshScheduler};";
  new Function("require", "module", "exports", "__dirname", "setTimeout", "clearTimeout", fs.readFileSync(file, "utf8") + appended)
    (mockedRequire, m, m.exports, path.dirname(file), clock.setTimer, clock.clearTimer);
  Object.assign(m.exports.refreshScheduler, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async options => { calls.push(options); } });
  m.exports.startCodexWatch();
  for (let i = 0; i < 100; i++) onChange("change", "logs_2.sqlite-shm");
  await clock.advance(20000);
  assert.equal(calls.length, 0);
  for (let i = 0; i < 100; i++) onChange("change", "logs_2.sqlite-wal");
  await clock.advance(4000); await clock.advance(0);
  assert.deepEqual(calls, [{ sources: ["codex"], forcePricing: false }]);
  m.exports.refreshScheduler.dispose();
});

function clockFixture() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: time + delay }); return key; },
    clearTimer: key => timers.delete(key),
    async advance(ms) {
      time += ms;
      for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
      await new Promise(setImmediate);
    },
  };
}

test("refreshes merge noisy source changes, obey background cadence and never drop work during a slow pull", async () => {
  const clock = clockFixture();
  const runs = [];
  let finish;
  const scheduler = new RefreshScheduler({ ...clock, interval: () => 15000,
    run: options => { runs.push(options); return new Promise(resolve => { finish = resolve; }); } });
  const initial = scheduler.request();
  await clock.advance(0);
  const codex = scheduler.request({ sources: ["codex"], background: true });
  const claude = scheduler.request({ sources: ["claude"], background: true });
  finish("initial");
  await initial;
  await clock.advance(14999);
  assert.equal(runs.length, 1);
  await clock.advance(1);
  assert.deepEqual(runs[1].sources.sort(), ["claude", "codex"]);
  const during = scheduler.request({ sources: ["devin"], background: true });
  finish("changed");
  await Promise.all([codex, claude]);
  await clock.advance(15000);
  assert.deepEqual(runs[2].sources, ["devin"]);
  finish("devin");
  await during;
  scheduler.dispose();
});

test("manual/full refresh supersedes queued partial work and bypasses background delay; shutdown cancels pending work", async () => {
  const clock = clockFixture();
  const runs = [];
  const scheduler = new RefreshScheduler({ ...clock, interval: () => 15000, run: async options => { runs.push(options); return "ok"; } });
  const first = scheduler.request();
  await clock.advance(0); await first;
  const background = scheduler.request({ sources: ["codex"], background: true });
  const manual = scheduler.request({ forcePricing: true });
  await clock.advance(0);
  await Promise.all([background, manual]);
  assert.deepEqual(runs[1], { sources: null, forcePricing: true });
  const pending = scheduler.request({ sources: ["claude"], background: true });
  scheduler.dispose();
  await assert.rejects(pending, /正在退出/);
  await clock.advance(15000);
  assert.equal(runs.length, 2);
});
