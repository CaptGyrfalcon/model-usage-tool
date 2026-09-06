const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UsageHistory } = require("../src/history.cjs");
const { CodexUsageScanner, mergeRateLimitSnapshots } = require("../src/codex.cjs");
const { DatabaseSync } = require("node:sqlite");

test("preserves both sides of a reset inside five minutes and supersedes legacy mixed-pool samples", () => {
  class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
  const history = new FixtureHistory(":memory:");
  try {
    const base = { source: "codex", pool: "primary-10080", windowMinutes: 10080 };
    history.saveQuotaSample({ ...base, timestamp: 1000, usedPercent: 88, resetsAt: 100000, planType: "plus" });
    history.saveQuotaSample({ ...base, timestamp: 2000, usedPercent: 0, resetsAt: 200000 }); // legacy Spark
    history.saveQuotaSample({ ...base, timestamp: 3000, usedPercent: 1, resetsAt: 300000, planType: "prolite" });
    const samples = history.getQuotaSamples();
    assert.deepEqual(samples.map((s) => s.usedPercent), [88, 1]);
    assert.deepEqual(samples.map((s) => s.planType), ["plus", "prolite"]);
    assert.equal(history.db.prepare("SELECT count(*) AS n FROM quota_samples").get().n, 3);
  } finally { history.close(); }
});

test("adds quota cycle starts to an old database without losing samples", () => {
  class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-start-test-"));
  const dbPath = path.join(temp, "history.sqlite");
  let history;
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE quota_samples (source TEXT NOT NULL, pool TEXT NOT NULL, bucket INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, used_percent REAL, window_minutes INTEGER, resets_at INTEGER,
      PRIMARY KEY(source,pool,bucket));
      INSERT INTO quota_samples VALUES ('cursor','cursor-models',0,1000,20,NULL,9000);`);
    old.close();
    history = new FixtureHistory(dbPath);
    assert.equal(history.getQuotaSamples()[0].usedPercent, 20);
    assert.equal(history.getQuotaSamples()[0].startsAt, null);
    const sample = { source: "cursor", pool: "cursor-models", timestamp: 1100, resetsAt: 9000, usedPercent: 21 };
    history.saveQuotaSample({ ...sample, startsAt: 100 });
    history.saveQuotaSample({ ...sample, usedPercent: 22 });
    assert.equal(history.getQuotaSamples()[0].startsAt, 100);
    history.saveQuotaSample({ ...sample, resetsAt: 18000 });
    assert.equal(history.getQuotaSamples()[0].startsAt, null);
    assert.equal(history.getQuotaSamples().length, 1);
  } finally {
    history?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("persists normalized events and deduplicates by source/event key", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-test-"));
  const dbPath = path.join(temp, "history.sqlite");
  try {
    const history = new UsageHistory(dbPath);
    const event = {
      source: "codex",
      eventKey: "session:one",
      timestamp: 1_000,
      model: "gpt-5.6-sol",
      effort: "high",
      fastKnown: false,
      input: 80,
      output: 20,
      cacheRead: 40,
      reasoning: 5,
      costCents: null,
    };
    history.upsertEvents([event, event]);
    history.saveCache("snapshot", { ok: true });
    assert.equal(history.stats().count, 1);
    assert.deepEqual(history.loadCache("snapshot").value, { ok: true });
    history.close();

    const reopened = new UsageHistory(dbPath);
    const rows = reopened.getEvents({ sources: "codex", start: 0, end: 2_000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fastKnown, false);
    assert.equal(rows[0].reasoning, 5);
    reopened.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("extracts Codex token metadata without reading message bodies", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-scan-test-"));
  const sessions = path.join(temp, "sessions", "2026", "08", "24");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "rollout-test.jsonl");
  const rows = [
    { timestamp: "2026-08-24T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1", originator: "Codex Desktop" } },
    { timestamp: "2026-08-24T00:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } },
    {
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 },
        },
        rate_limits: {
          primary: { used_percent: 25, window_minutes: 300, resets_at: 1_800_000_000 },
          secondary: { used_percent: 8, window_minutes: 10_080, resets_at: 1_800_600_000 },
          plan_type: "plus",
        },
      },
    },
    {
      timestamp: "2026-08-24T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 },
        },
      },
    },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  try {
    const scanner = new CodexUsageScanner(temp);
    const first = scanner.scan();
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].input, 40);
    assert.equal(first.events[0].cacheRead, 60);
    assert.equal(first.events[0].effort, "xhigh");
    assert.equal(first.events[0].fastKnown, false);
    assert.match(first.events[0].eventKey, /^codex:v2:/);
    assert.equal(first.events[0].legacyEventKeys.length, 2);
    assert.equal(first.rateLimit.primary.usedPercent, 25);
    assert.equal(first.rateLimit.secondary.windowMinutes, 10_080);
    assert.deepEqual(first.rateLimit.windows.map((window) => [window.slot, window.windowMinutes]), [
      ["primary", 300],
      ["secondary", 10_080],
    ]);
    assert.equal(scanner.scan().events.length, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("recovers current Codex five-hour and weekly quotas from response-header logs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rate-log-test-"));
  const dbPath = path.join(temp, "logs_2.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        target TEXT,
        thread_id TEXT,
        feedback_log_body TEXT
      )
    `);
    const headers = JSON.stringify({
      "x-codex-active-limit": "premium",
      "x-codex-plan-type": "plus",
      "x-codex-primary-used-percent": "56",
      "x-codex-secondary-used-percent": "16",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1800009000",
      "x-codex-secondary-reset-at": "1800500000",
      "x-codex-credits-has-credits": "False",
      "x-codex-credits-unlimited": "False",
      "x-codex-credits-balance": "0",
    });
    db.prepare("INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)")
      .run(1_800_000_000, "codex_http_client::client", `response headers: ${headers}`);
    db.close();

    const result = new CodexUsageScanner(temp).scan();
    assert.equal(result.planType, "plus");
    assert.deepEqual(result.rateLimit.windows.map((window) => [window.slot, window.windowMinutes, window.usedPercent]), [
      ["primary", 300, 56],
      ["secondary", 10_080, 16],
    ]);
    assert.equal(result.rateLimit.primary.resetsAt, 1_800_009_000_000);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("does not replace the main Codex quota with the separate gpt-reserve pool", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reserve-rate-test-"));
  const sessions = path.join(temp, "sessions", "2026", "08", "27");
  fs.mkdirSync(sessions, { recursive: true });
  const dbPath = path.join(temp, "logs_2.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, target TEXT, thread_id TEXT, feedback_log_body TEXT)");
    const headers = JSON.stringify({
      "x-codex-active-limit": "premium",
      "x-codex-plan-type": "plus",
      "x-codex-primary-used-percent": "4",
      "x-codex-secondary-used-percent": "1",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1800009000",
      "x-codex-secondary-reset-at": "1800500000",
    });
    db.prepare("INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)")
      .run(1_800_000_000, "codex_http_client::client", `response headers: ${headers}`);
    db.close();
    fs.writeFileSync(path.join(sessions, "rollout-reserve.jsonl"), `${JSON.stringify({
      timestamp: "2027-01-15T08:00:01.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "base_model_inference",
          limit_name: "gpt-reserve",
          primary: { used_percent: 0, window_minutes: 10_080, resets_at: 1_800_600_000 },
          secondary: null,
          plan_type: "plus",
        },
      },
    })}\n`);

    const result = new CodexUsageScanner(temp).scan();
    assert.equal(result.rateLimit.limitId, "premium");
    assert.deepEqual(result.rateLimit.windows.map((window) => [window.windowMinutes, window.usedPercent]), [
      [300, 4],
      [10_080, 1],
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("merges partial Codex quota responses by window duration", () => {
  const weeklyReset = 1_800_500_000_000;
  const merged = mergeRateLimitSnapshots([
    {
      timestamp: 1_800_000_100_000,
      primary: { windowMinutes: 300, usedPercent: 24, percentRemaining: 76, resetsAt: 1_800_010_000_000 },
      secondary: null,
      windows: [{ slot: "primary", windowMinutes: 300, usedPercent: 24, percentRemaining: 76, resetsAt: 1_800_010_000_000 }],
    },
    {
      timestamp: 1_800_000_000_000,
      primary: { windowMinutes: 10_080, usedPercent: 17, percentRemaining: 83, resetsAt: weeklyReset },
      secondary: null,
      windows: [{ slot: "primary", windowMinutes: 10_080, usedPercent: 17, percentRemaining: 83, resetsAt: weeklyReset }],
    },
  ]);
  assert.deepEqual(merged.windows.map((window) => [window.slot, window.windowMinutes, window.usedPercent]), [
    ["primary", 300, 24],
    ["secondary", 10_080, 17],
  ]);
});

test("extracts official nested Codex cache-write usage without double-counting input", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cache-write-test-"));
  const sessions = path.join(temp, "sessions", "2026", "08", "25");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "rollout-cache-write.jsonl");
  const rows = [
    { timestamp: "2026-08-25T00:00:00.000Z", type: "session_meta", payload: { id: "thread-cache-write" } },
    { timestamp: "2026-08-25T00:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
    {
      timestamp: "2026-08-25T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: {
          input_tokens: 1_000,
          cached_input_tokens: 600,
          input_tokens_details: { cache_write_tokens: 250 },
          output_tokens: 100,
          total_tokens: 1_100,
        } },
      },
    },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`);
  try {
    const event = new CodexUsageScanner(temp).scan().events[0];
    assert.equal(event.input, 150);
    assert.equal(event.cacheRead, 600);
    assert.equal(event.cacheWrite, 250);
    assert.equal(event.input + event.cacheRead + event.cacheWrite, 1_000);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("full weekly-only snapshots remove a stale 5h window, while partial responses retain uncertainty", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-no-short-"));
  fs.mkdirSync(path.join(temp, "sessions"));
  const file = path.join(temp, "sessions", "rollout-quota.jsonl");
  const weekly = { window_minutes: 10080, used_percent: 30, resets_at: 1800600000 };
  const record = (limits) => JSON.stringify({ timestamp: "2026-09-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: limits } });
  try {
    fs.writeFileSync(file, record({ plan_type: "pro", primary: null, secondary: weekly }) + "\n");
    const absent = new CodexUsageScanner(temp).scan().rateLimit;
    assert.equal(absent.shortLimit, "absent");
    const stale = { timestamp: absent.timestamp - 1000, windows: [{ windowMinutes: 300, resetsAt: absent.timestamp + 3600000, usedPercent: 50 }] };
    const merged = mergeRateLimitSnapshots([{ timestamp: absent.timestamp + 1000, windows: absent.windows }, absent, stale]);
    assert.equal(merged.shortLimit, "absent");
    assert.deepEqual(merged.windows.map((window) => window.windowMinutes), [10080]);
    fs.writeFileSync(file, record({ plan_type: "pro", secondary: weekly }) + "\n");
    assert.equal(new CodexUsageScanner(temp).scan().rateLimit.shortLimit, "unknown");
    fs.writeFileSync(file, record({ plan_type: "pro", primary: { window_minutes: 300, used_percent: 0 }, secondary: weekly }) + "\n");
    assert.equal(new CodexUsageScanner(temp).scan().rateLimit.shortLimit, "present");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("locks event pricing on first persistence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-pricing-lock-test-"));
  const dbPath = path.join(temp, "history.sqlite");
  try {
    const history = new UsageHistory(dbPath);
    const base = {
      source: "codex", eventKey: "locked", timestamp: 1_000, model: "gpt-5.6-sol",
      input: 100, output: 10, cacheRead: 20, fast: false, fastKnown: true,
      equivalentCostCents: 1.25, inputCostCents: 0.5, cacheCostCents: 0.25,
      cacheReadCostCents: 0.1, cacheWriteCostCents: 0.15,
      outputCostCents: 0.5, pricingSnapshotId: 1, pricingStatus: "official-rate",
    };
    history.upsertEvents([base]);
    history.upsertEvents([{ ...base, equivalentCostCents: 99, inputCostCents: 99, pricingSnapshotId: 2 }]);
    const row = history.getEvents({ start: 0, end: 2_000 })[0];
    assert.equal(row.equivalentCostCents, 1.25);
    assert.equal(row.inputCostCents, 0.5);
    assert.equal(row.cacheReadCostCents, 0.1);
    assert.equal(row.cacheWriteCostCents, 0.15);
    assert.equal(row.pricingSnapshotId, 1);
    history.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reprices events that were stored before a model entered the catalog", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-unavailable-reprice-test-"));
  const { priceEvent, builtInSnapshot } = require("../src/pricing.cjs");
  try {
    const history = new UsageHistory(path.join(temp, "history.sqlite"));
    history.upsertEvents([{
      source: "codex", eventKey: "astra-miss", timestamp: 1_000, model: "gpt-6-astra",
      input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0,
      fast: false, fastKnown: true, pricingSnapshotId: 1, pricingStatus: "unavailable",
    }]);
    const unpriced = history.getUnpricedEvents();
    assert.equal(unpriced.length, 1);
    const priced = priceEvent(unpriced[0], builtInSnapshot(1));
    history.upsertEvents([{ ...unpriced[0], ...priced, pricingSnapshotId: 2 }]);
    const row = history.getEvents({ start: 0, end: 2_000 })[0];
    assert.equal(row.equivalentCostCents, 150);
    assert.equal(row.quotaEquivalentCostCents, 150);
    assert.equal(row.pricingSnapshotId, 2);
    assert.notEqual(row.pricingStatus, "unavailable");
    history.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("maps Codex priority service tier from local request logs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tier-test-"));
  const sessions = path.join(temp, "sessions", "2026", "08", "24");
  fs.mkdirSync(sessions, { recursive: true });
  const db = new DatabaseSync(path.join(temp, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, thread_id TEXT, feedback_log_body TEXT)");
  db.prepare("INSERT INTO logs VALUES (?, ?, ?, ?, ?)").run(
    1, Date.parse("2026-08-24T00:00:01Z") / 1000, "codex_core::session::handlers", "thread-fast",
    'TurnParams { service_tier: Some(Some("priority")) }',
  );
  db.close();
  const file = path.join(sessions, "rollout-fast.jsonl");
  const rows = [
    { timestamp: "2026-08-24T00:00:00.000Z", type: "session_meta", payload: { id: "thread-fast" } },
    { timestamp: "2026-08-24T00:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
    { timestamp: "2026-08-24T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`);
  try {
    const event = new CodexUsageScanner(temp).scan().events[0];
    assert.equal(event.fastKnown, true);
    assert.equal(event.fast, true);
    assert.equal(event.serviceTier, "priority");
    assert.equal(event.tierSource, "local-log");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("prefers a server response service tier over the local request tier", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-response-tier-test-"));
  const sessions = path.join(temp, "sessions", "2026", "08", "24");
  fs.mkdirSync(sessions, { recursive: true });
  const db = new DatabaseSync(path.join(temp, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, thread_id TEXT, feedback_log_body TEXT)");
  db.prepare("INSERT INTO logs VALUES (?, ?, ?, ?, ?)").run(
    1, Date.parse("2026-08-24T00:00:01Z") / 1000, "codex_core::session::handlers", "thread-response",
    'TurnParams { service_tier: Some(Some("priority")) }',
  );
  db.close();
  const file = path.join(sessions, "rollout-response.jsonl");
  const rows = [
    { timestamp: "2026-08-24T00:00:00.000Z", type: "session_meta", payload: { id: "thread-response" } },
    { timestamp: "2026-08-24T00:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
    { timestamp: "2026-08-24T00:00:01.500Z", type: "event_msg", payload: { type: "response_completed", response: { service_tier: "default" } } },
    { timestamp: "2026-08-24T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`);
  try {
    const event = new CodexUsageScanner(temp).scan().events[0];
    assert.equal(event.fast, false);
    assert.equal(event.serviceTier, "default");
    assert.equal(event.tierSource, "response");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("response tier evidence replaces request evidence and its calculated costs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-tier-priority-test-"));
  const history = new UsageHistory(path.join(temp, "history.sqlite"));
  try {
    const base = {
      source: "codex", eventKey: "same-request", timestamp: 1_000, model: "gpt-5.6-sol",
      input: 100, output: 10, fast: true, fastKnown: true, serviceTier: "priority", tierSource: "local-log",
      equivalentCostCents: 2, quotaEquivalentCostCents: 2.5, pricingSnapshotId: 1,
    };
    history.upsertEvents([base]);
    history.upsertEvents([{ ...base, fast: false, serviceTier: "default", tierSource: "response", equivalentCostCents: 1, quotaEquivalentCostCents: 1 }]);
    history.upsertEvents([{ ...base, equivalentCostCents: 99, quotaEquivalentCostCents: 99 }]);
    const event = history.getEvents({ sources: "codex", start: 0, end: 2_000 })[0];
    assert.equal(event.fast, false);
    assert.equal(event.tierSource, "response");
    assert.equal(event.equivalentCostCents, 1);
    assert.equal(event.quotaEquivalentCostCents, 1);
  } finally {
    history.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("migrates previously stored Codex API-equivalent costs to the credit-multiplier basis", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-unified-cost-test-"));
  const history = new UsageHistory(path.join(temp, "history.sqlite"));
  try {
    history.upsertEvents([{
      source: "codex", eventKey: "old-fast", timestamp: 1_000, model: "gpt-5.6-sol",
      input: 100, output: 10, fast: true, fastKnown: true,
      inputCostCents: 2, cacheCostCents: 1, outputCostCents: 5,
      cacheReadCostCents: 0.4, cacheWriteCostCents: 0.6,
      equivalentCostCents: 8, equivalentCostLowCents: 8, equivalentCostHighCents: 8,
      quotaEquivalentCostCents: 10, quotaEquivalentCostLowCents: 10, quotaEquivalentCostHighCents: 10,
    }]);
    assert.equal(history.unifyCodexDollarEquivalent(), 1);
    const event = history.getEvents({ sources: "codex", start: 0, end: 2_000 })[0];
    assert.equal(event.equivalentCostCents, 10);
    assert.equal(event.inputCostCents, 2.5);
    assert.equal(event.cacheCostCents, 1.25);
    assert.equal(event.cacheReadCostCents, 0.5);
    assert.equal(event.cacheWriteCostCents, 0.75);
    assert.equal(event.outputCostCents, 6.25);
    assert.equal(history.unifyCodexDollarEquivalent(), 0);
  } finally {
    history.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("backs up and removes cumulative Cursor snapshot pollution", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cursor-dedupe-test-"));
  const dbPath = path.join(temp, "history.sqlite");
  const history = new UsageHistory(dbPath);
  try {
    const identity = "2026-08-25T00:00:00.000Z|cursor-grok-4.6-high|conversation-1";
    history.upsertEvents([
      { source: "cursor", eventKey: `${identity}|100|10|20|0|2`, timestamp: 1_000, model: "cursor-grok-4.6-high", input: 100, output: 10, cacheRead: 20, costCents: 2, equivalentCostCents: 2 },
      { source: "cursor", eventKey: `${identity}|200|20|200|0|8`, timestamp: 1_000, model: "cursor-grok-4.6-high", input: 200, output: 20, cacheRead: 200, costCents: 8, equivalentCostCents: 8 },
      { source: "cursor", eventKey: `${identity}|150|15|100|0|5`, timestamp: 1_000, model: "cursor-grok-4.6-high", input: 150, output: 15, cacheRead: 100, costCents: 5, equivalentCostCents: 5 },
    ]);
    const migration = history.migrateCursorSnapshotEvents({ force: true });
    const rows = history.getEvents({ sources: "cursor", start: 0, end: 2_000 });
    assert.equal(migration.removed, 2);
    assert.equal(migration.duplicateGroups, 1);
    assert.equal(fs.existsSync(migration.backupPath), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].equivalentCostCents, 8);
    assert.match(rows[0].eventKey, /^cursor:v2:/);

    history.upsertEvents([{
      ...rows[0], input: 250, output: 30, cacheRead: 300,
      costCents: 10, equivalentCostCents: 10,
    }]);
    const updated = history.getEvents({ sources: "cursor", start: 0, end: 2_000 });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].equivalentCostCents, 10);
    assert.equal(updated[0].cacheRead, 300);
  } finally {
    history.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("backs up and removes duplicate Codex cumulative broadcasts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-codex-dedupe-test-"));
  const dbPath = path.join(temp, "history.sqlite");
  const history = new UsageHistory(dbPath);
  try {
    const base = {
      source: "codex", timestamp: 1_000, model: "gpt-5.6-sol", effort: "high",
      input: 40, cacheRead: 60, output: 20, equivalentCostCents: 4,
    };
    history.upsertEvents([
      { ...base, eventKey: "thread:2026-08-24T00:00:02.000Z:120:gpt-5.6-sol:high" },
      { ...base, eventKey: "thread:2026-08-24T00:00:03.000Z:120:gpt-5.6-sol:high", timestamp: 2_000 },
    ]);
    const targetKey = "codex:v2:thread:100:60:20:120";
    const migration = history.migrateCodexCumulativeEvents([{
      ...base,
      eventKey: targetKey,
      legacyEventKeys: [
        "thread:2026-08-24T00:00:02.000Z:120:gpt-5.6-sol:high",
        "thread:2026-08-24T00:00:03.000Z:120:gpt-5.6-sol:high",
      ],
    }]);
    const rows = history.getEvents({ sources: "codex", start: 0, end: 3_000 });
    assert.equal(migration.migrated, 2);
    assert.equal(migration.removed, 1);
    assert.equal(migration.duplicateGroups, 1);
    assert.equal(fs.existsSync(migration.backupPath), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventKey, targetKey);
    assert.equal(rows[0].timestamp, 1_000);
    assert.equal(rows[0].equivalentCostCents, 4);

    history.upsertEvents([{ ...base, eventKey: targetKey, timestamp: 2_000 }]);
    const updated = history.getEvents({ sources: "codex", start: 0, end: 3_000 });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].timestamp, 1_000);
  } finally {
    history.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("pages request history and lists quota samples", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-query-test-"));
  const history = new UsageHistory(path.join(temp, "history.sqlite"));
  try {
    history.upsertEvents([
      { source: "cursor", eventKey: "query-a", timestamp: 1_000, model: "unique-query-grok", input: 10, output: 2 },
      { source: "codex", eventKey: "query-b", timestamp: 2_000, model: "gpt-5.6-sol", effort: "high", input: 20, output: 4 },
      { source: "cursor", eventKey: "query-c", timestamp: 3_000, model: "composer-2.5", input: 8, output: 1 },
    ]);
    assert.equal(history.stats().count, 3);
    history.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp: 3_000, usedPercent: 41, resetsAt: 9_000 });
    const page = history.queryEvents({ sources: "cursor", query: "unique-query-grok", offset: 0, limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.events[0].model, "unique-query-grok");
    const samples = history.getQuotaSamples().filter((sample) => sample.usedPercent === 41 && sample.resetsAt === 9_000);
    assert.equal(samples.length, 1);
    history.saveQuotaSample({ source: "codex", pool: "secondary-10080", timestamp: 4_000, usedPercent: 25, windowMinutes: 10080, resetsAt: 12_000 });
    assert.equal(history.getQuotaSamples({ source: "codex", start: 4_000, end: 4_001 }).length, 1);
    assert.equal(history.getQuotaSamples({ source: "codex", start: 0, end: 4_000 }).length, 0);
    assert.equal(history.getQuotaSamples({ source: "cursor", start: 4_000, end: 4_001 }).length, 0);
    assert.deepEqual(history.getQuotaConsumption({ source: "codex", start: 2_000, end: 2_001 }), [
      { source: "codex", timestamp: 2_000, quotaEquivalentCostCents: null },
    ]);
    assert.equal(history.getQuotaConsumption({ source: "codex", start: 1_000, end: 2_000 }).length, 0);
    const snapshots = history.listPricingSnapshots();
    assert.equal(Array.isArray(snapshots), true);
  } finally {
    history.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
