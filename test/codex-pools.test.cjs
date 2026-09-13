const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CodexUsageScanner, rateLimitFromResponseHeaders } = require("../src/codex.cjs");
const { UsageHistory } = require("../src/history.cjs");

test("Spark account updates in an Astra session cannot replace main quota or pollute history", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pools-"));
  class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
  const history = new FixtureHistory(":memory:");
  const base = 1_800_000_000;
  const weekly = { used_percent: 52, window_minutes: 10080, resets_at: base + 400000 };
  const sparkWeekly = { used_percent: 2, window_minutes: 10080, resets_at: base + 410000 };
  const record = (seconds, limits) => JSON.stringify({
    timestamp: new Date(seconds * 1000).toISOString(), type: "event_msg",
    payload: { type: "token_count", rate_limits: limits,
      info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  }) + "\n";
  try {
    fs.mkdirSync(path.join(temp, "sessions"));
    const file = path.join(temp, "sessions", "astra.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n"
      + record(base, { limit_id: "codex", primary: weekly, secondary: null, plan_type: "prolite" }));
    const scanner = new CodexUsageScanner(temp);
    assert.equal(scanner.scan().rateLimit.primary.usedPercent, 52);
    // The label may be absent; the internal ID must still identify Spark.
    fs.appendFileSync(file, record(base + 1, { limit_id: "codex_bengalfox", limit_name: null,
      primary: { used_percent: 2, window_minutes: 300, resets_at: base + 3000 }, secondary: sparkWeekly }));
    let result = scanner.scan();
    assert.equal(result.rateLimit.primary.usedPercent, 52);
    assert.equal(result.rateLimit.primary.percentRemaining, 48);
    assert.equal(result.rateLimit.shortLimit, "absent");
    assert.equal(result.quotaSamples.length, 0);
    assert.equal(result.events.length, 1); // Actual token usage is still retained.
    assert.equal(result.events[0].model, "gpt-6-astra");

    // Old versions wrote Spark rows with the last known plan, sometimes with
    // remapped slots. Match original observations without trusting either.
    for (const sample of result.excludedQuotaSamples) history.saveQuotaSample({
      ...sample, source: "codex", pool: `primary-${sample.windowMinutes}`, planType: "prolite",
    });
    history.saveQuotaSample({ source: "codex", pool: "secondary-10080", timestamp: (base + 1) * 1000,
      windowMinutes: 10080, usedPercent: 2, resetsAt: weekly.resets_at * 1000, planType: "prolite" });
    history.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp: (base + 1) * 1000,
      windowMinutes: 10080, usedPercent: 2, resetsAt: sparkWeekly.resets_at * 1000 });
    assert.equal(history.quarantineCodexQuotaSamples(result.excludedQuotaSamples), 2);
    assert.equal(history.quarantineCodexQuotaSamples(result.excludedQuotaSamples), 0);
    assert.equal(history.db.prepare("SELECT count(*) AS n FROM excluded_codex_quota_samples").get().n, 2);
    assert.equal(history.db.prepare("SELECT count(*) AS n FROM quota_samples").get().n, 2);

    // Real resets and quota corrections must still be accepted.
    fs.appendFileSync(file, record(base + 2, { limit_id: "codex", primary: { ...weekly, used_percent: 1 },
      secondary: null, plan_type: "prolite" }));
    result = scanner.scan();
    assert.equal(result.rateLimit.primary.usedPercent, 1);
    const restarted = new CodexUsageScanner(temp).scan();
    assert.equal(restarted.rateLimit.primary.usedPercent, 1);
    assert.deepEqual(restarted.quotaSamples.map((sample) => sample.usedPercent), [52, 1]);
  } finally {
    history.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("codex-pools-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("separate pool names and internal IDs are filtered consistently across sessions and headers", () => {
  const window = { used_percent: 2, window_minutes: 10080, resets_at: 1_800_600_000 };
  for (const identity of [
    { limit_id: "codex_bengalfox" },
    { limit_id: " CODEX_BENGALFOX " },
    { limit_name: "GPT-5.3-Codex-Spark" },
    { limit_id: "codex", limit_name: "GPT-5.3-Codex-Spark" },
    { limit_id: "base_model_inference" },
    { limit_name: "gpt-reserve" },
  ]) {
    const scanner = new CodexUsageScanner();
    scanner.parseLine(JSON.stringify({ timestamp: "2027-01-15T08:00:00Z", type: "event_msg",
      payload: { type: "token_count", rate_limits: { ...identity, primary: window } } }),
    { model: "gpt-6-astra" }, "fixture", []);
    assert.equal(scanner.latestRateLimit, null, JSON.stringify(identity));
    assert.equal(scanner.quotaSamples.length, 0);
    assert.equal(rateLimitFromResponseHeaders(JSON.stringify({
      "x-codex-active-limit": identity.limit_name || identity.limit_id,
      "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "2",
    }), 1_800_000_000), null);
  }
  for (const id of ["premium", "codex", undefined]) {
    assert.equal(rateLimitFromResponseHeaders(JSON.stringify({
      "x-codex-active-limit": id,
      "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "52",
    }), 1_800_000_000).primary.percentRemaining, 48);
  }
});

test("Spark HTTP headers cannot overwrite the ordinary quota during log merging", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pools-"));
  const db = new DatabaseSync(path.join(temp, "logs_2.sqlite"));
  try {
    db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, thread_id TEXT, feedback_log_body TEXT)");
    const insert = db.prepare("INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)");
    for (const [seconds, id, used] of [[1800000000, "premium", 52], [1800000001, "codex_bengalfox", 2]]) {
      insert.run(seconds, "codex_http_client::client", JSON.stringify({
        "x-codex-active-limit": id, "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-used-percent": String(used), "x-codex-primary-reset-at": "1800600000",
      }));
    }
    const result = new CodexUsageScanner(temp).scan();
    assert.equal(result.rateLimit.primary.usedPercent, 52);
    assert.deepEqual(result.quotaSamples.map((sample) => sample.usedPercent), [52]);
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("codex-pools-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
