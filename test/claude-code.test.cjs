const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeCodeScanner, eventFromRecord, claudeConfigDirs } = require("../src/claude-code.cjs");
const { builtInSnapshot, claudeModelKey, priceEvent } = require("../src/pricing.cjs");
const { flattenPricingSnapshot } = require("../src/pricing-table.cjs");
const { UsageHistory } = require("../src/history.cjs");

function assistant({ id = "msg_1", requestId = "req_1", model = "claude-opus-5-5", usage = {}, ...rest } = {}) {
  return {
    type: "assistant",
    timestamp: "2026-09-29T21:49:29.439Z",
    requestId,
    sessionId: "session-1",
    effort: "medium",
    message: { id, model, usage: {
      input_tokens: 2, output_tokens: 395, cache_read_input_tokens: 60915, cache_creation_input_tokens: 8011,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8011 },
      service_tier: "standard", speed: "standard", ...usage,
    } },
    ...rest,
  };
}

function fixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-test-"));
}

test("a response split across transcript lines is counted once", () => {
  const root = fixtureDir();
  try {
    const project = path.join(root, "C--work");
    fs.mkdirSync(path.join(project, "session-1", "subagents"), { recursive: true });
    const lines = [
      assistant(), assistant(), assistant(),
      assistant({ id: "msg_2", requestId: "req_2" }),
      { type: "user", message: { role: "user", content: "hi" } },
      assistant({ id: "msg_3", model: "<synthetic>" }),
    ].map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(path.join(project, "session-1.jsonl"), `${lines}\n`);
    fs.writeFileSync(path.join(project, "session-1", "subagents", "agent-a.jsonl"),
      `${JSON.stringify(assistant({ id: "msg_sub", requestId: "req_sub", isSidechain: true }))}\n`);
    const scan = new ClaudeCodeScanner([root]).scan();
    assert.equal(scan.files, 2);
    assert.deepEqual(scan.events.map((event) => event.eventKey).sort(),
      ["claude:msg_1:req_1", "claude:msg_2:req_2", "claude:msg_sub:req_sub"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scans are incremental and wait for a line to be complete", () => {
  const root = fixtureDir();
  try {
    const file = path.join(root, "session.jsonl");
    const scanner = new ClaudeCodeScanner([root]);
    const complete = JSON.stringify(assistant());
    const next = JSON.stringify(assistant({ id: "msg_2", requestId: "req_2" }));
    fs.writeFileSync(file, `${complete}\n${next.slice(0, 40)}`);
    assert.equal(scanner.scan().events.length, 1);
    fs.appendFileSync(file, `${next.slice(40)}\n`);
    assert.deepEqual(scanner.scan().events.map((event) => event.eventKey), ["claude:msg_2:req_2"]);
    assert.equal(scanner.scan().events.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("usage fields map onto the shared event shape", () => {
  const event = eventFromRecord(assistant({ usage: { speed: "fast" } }));
  assert.equal(event.source, "claude");
  assert.equal(event.pool, "claude");
  assert.equal(event.input, 2);
  assert.equal(event.output, 395);
  assert.equal(event.cacheRead, 60915);
  assert.equal(event.cacheWrite, 8011);
  assert.equal(event.cacheWrite1h, 8011);
  assert.equal(event.effort, "medium");
  assert.equal(event.fast, true);
  assert.equal(event.fastKnown, true);
  assert.equal(eventFromRecord({ ...assistant(), type: "user" }), null);
  assert.equal(eventFromRecord(assistant({ usage: { input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })), null);
});

test("CLAUDE_CONFIG_DIR accepts a comma-separated list", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = " /a/one , /b/two ";
  try {
    assert.deepEqual(claudeConfigDirs(), [path.resolve("/a/one"), path.resolve("/b/two")]);
  } finally {
    if (previous == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("list-price cost matches Claude Code's own cost-state totals", () => {
  // Totals copied from two real `cost-state` records written by Claude Code.
  const sessions = [
    { input: 2656, output: 36324, cacheRead: 7940291, cacheWrite: 126697, costUSD: 3.3387382 },
    { input: 618, output: 80515, cacheRead: 7371412, cacheWrite: 162395, costUSD: 4.3862144 },
  ];
  for (const session of sessions) {
    const priced = priceEvent({ source: "claude", model: "claude-opus-5-5", fast: false, fastKnown: true,
      cacheWrite1h: session.cacheWrite, ...session }, builtInSnapshot());
    assert.ok(Math.abs(priced.equivalentCostCents - session.costUSD * 100) < 1e-6, `${priced.equivalentCostCents}`);
    assert.equal(priced.pricingStatus, "official-rate");
  }
});

test("five-minute cache writes, Fast mode and model aliases use their own rates", () => {
  const snapshot = builtInSnapshot();
  const base = { source: "claude", model: "claude-opus-5-5", input: 0, output: 0, cacheRead: 0, fastKnown: true };
  const cents = (event) => priceEvent({ ...base, ...event }, snapshot).equivalentCostCents;
  assert.equal(cents({ cacheWrite: 1_000_000, cacheWrite1h: 0 }), 500);
  assert.equal(cents({ cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }), 800);
  assert.equal(cents({ output: 1_000_000, fast: true }), 4000);
  assert.equal(cents({ output: 1_000_000, model: "claude-haiku-4-5-20251001" }), 500);
  assert.equal(cents({ output: 1_000_000, model: "claude-opus-5" }), 2500);
  assert.equal(claudeModelKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(priceEvent({ ...base, model: "claude-unknown-9", output: 1 }, snapshot).pricingStatus, "unavailable");
  // Cursor's Claude prices are unaffected by the Anthropic catalog.
  assert.equal(priceEvent({ ...base, source: "cursor", output: 1_000_000 }, snapshot).equivalentCostCents, 2500);
});

test("pricing table lists the Claude Code catalog", () => {
  const rows = flattenPricingSnapshot(builtInSnapshot(), { source: "claude" });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.source === "claude"));
  assert.ok(rows.some((row) => row.model === "claude-opus-5-5" && row.speed === "fast"));
});

test("history keeps the one-hour cache-write split for repricing", () => {
  class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
  const history = new FixtureHistory(":memory:");
  try {
    const event = eventFromRecord(assistant());
    history.upsertEvents([{ ...event, ...priceEvent(event, builtInSnapshot()) }]);
    const stored = history.getEvent("claude", event.eventKey);
    assert.equal(stored.cacheWrite1h, 8011);
    assert.equal(stored.pool, "claude");
    assert.equal(priceEvent(stored, builtInSnapshot()).equivalentCostCents, stored.equivalentCostCents);
  } finally {
    history.db.close();
  }
});
