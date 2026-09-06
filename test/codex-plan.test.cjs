const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CodexUsageScanner, codexPlanName } = require("../src/codex.cjs");

test("keeps the newest plan across session, archive, HTTP log and incremental scans", (t) => {
  const prefix = path.join(os.tmpdir(), "codex-plan-test-");
  const temp = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(prefix)));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = 1_800_000_000;
  const session = (seconds, plan) => JSON.stringify({
    timestamp: new Date(seconds * 1000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 1, window_minutes: 10080, resets_at: base + 600000 },
        plan_type: plan,
      },
    },
  }) + "\n";
  const sessionDir = path.join(temp, "sessions");
  const archiveDir = path.join(temp, "archived_sessions");
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(archiveDir);
  const currentFile = path.join(sessionDir, "current.jsonl");
  const archiveFile = path.join(archiveDir, "old.jsonl");
  fs.writeFileSync(currentFile, session(base + 100, "prolite"));
  fs.writeFileSync(archiveFile, session(base, "plus"));
  const db = new DatabaseSync(path.join(temp, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, thread_id TEXT, feedback_log_body TEXT)");
  const addLog = (seconds, plan) => db.prepare(
    "INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)"
  ).run(seconds, "codex_http_client::client", JSON.stringify({
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-used-percent": "1",
    "x-codex-plan-type": plan,
  }));
  try {
    addLog(base + 10, "plus");
    const scanner = new CodexUsageScanner(temp);
    let result = scanner.scan();
    assert.equal(result.planType, "prolite");
    assert.equal(result.rateLimit.planType, "prolite");
    assert.equal(codexPlanName(result.planType), "Pro 5×");
    assert.equal(scanner.scan().planType, "prolite");

    // Importing more old records must not downgrade the plan on a later refresh.
    fs.appendFileSync(archiveFile, session(base + 20, "plus"));
    assert.equal(scanner.scan().planType, "prolite");

    // A real, later plan change must still take effect, in either direction.
    addLog(base + 200, "plus");
    assert.equal(scanner.scan().planType, "plus");
    addLog(base + 300, "prolite");
    addLog(base + 400, null);
    assert.equal(scanner.scan().planType, "prolite");

    // New quota responses with no plan retain the latest known plan.
    fs.appendFileSync(currentFile, session(base + 500, null));
    assert.equal(scanner.scan().planType, "prolite");
    assert.equal(new CodexUsageScanner(temp).scan().planType, "prolite");
  } finally {
    db.close();
  }
});

test("formats the new Pro tier while preserving other and unknown plan names", () => {
  assert.equal(codexPlanName("prolite"), "Pro 5×");
  assert.equal(codexPlanName("plus"), "Plus");
  assert.equal(codexPlanName("pro"), "Pro");
  assert.equal(codexPlanName("business"), "Business");
  assert.equal(codexPlanName("future"), "Future");
  assert.equal(codexPlanName(null), "Codex");
});

test("recovers historical plans and ignores Spark quota mislabeled as codex without dropping its usage", () => {
  const scanner = new CodexUsageScanner();
  const events = [];
  const state = { model: "gpt-6-astra", sessionId: "fixture" };
  const base = Date.UTC(2026, 8, 7, 0);
  const record = (timestamp, plan, used, reset) => JSON.stringify({ timestamp: new Date(timestamp).toISOString(),
    type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", plan_type: plan,
      primary: { used_percent: used, window_minutes: 10080, resets_at: reset / 1000 }, secondary: null },
    info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } } });
  scanner.parseLine(record(base, "plus", 88, base + 86400_000), state, "fixture", events);
  scanner.parseLine(record(base + 1000, "prolite", 1, base + 604800_000), state, "fixture", events);
  state.model = "gpt-5.3-codex-spark";
  scanner.parseLine(record(base + 2000, "prolite", 0, base + 604802_000), state, "fixture", events);
  assert.equal(scanner.latestRateLimit.timestamp, base + 1000);
  assert.equal(scanner.quotaSamples.length, 2);
  assert.deepEqual(scanner.quotaSamples.map((s) => s.planType), ["plus", "prolite"]);
  assert.equal(events.length, 3);
  assert.equal(events[2].model, "gpt-5.3-codex-spark");
});
