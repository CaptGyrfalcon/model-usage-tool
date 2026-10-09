const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseStatusline, captureStatusline, readStatusline } = require("../src/claude-statusline.cjs");
const { buildClaudeQuota, toQuotaSamples, fromQuotaSamples, annotateQuotaSamples } = require("../src/claude-quota.cjs");
const T = Date.parse("2026-09-30T00:00:00Z");
const reset = T + 3600_000;
const input = { session_id: "a", rate_limits: { five_hour: { used_percentage: 73, resets_at: reset / 1000 },
  seven_day: { used_percentage: 16, resets_at: (T + 86_400_000) / 1000 } } };

test("official reset seconds survive history round-trip and quota construction", () => {
  const sample = parseStatusline(input, T);
  const rows = toQuotaSamples([sample]);
  assert.deepEqual(fromQuotaSamples(rows), [sample]);
  assert.equal(annotateQuotaSamples(rows)[0].resetsAt, reset);
  const quota = buildClaudeQuota({ samples: [sample], now: T });
  assert.equal(quota.source, "statusline");
  assert.equal(quota.primary.resetsAt, reset);
  assert.equal(quota.primary.usedPercent, 73);
  assert.equal(quota.primary.resetEstimated, false);
});

test("missing, null, malformed, and expired fields do not become zero quota", () => {
  for (const value of [undefined, null, "12", NaN, -1, 101]) {
    assert.equal(parseStatusline({ rate_limits: { five_hour: { used_percentage: value, resets_at: reset / 1000 } } }, T), null);
  }
  assert.equal(parseStatusline({}, T), null);
  assert.equal(parseStatusline(input, T + 2 * 86_400_000), null);
  assert.equal(parseStatusline({ rate_limits: { five_hour: { used_percentage: 0, resets_at: reset / 1000 } } }, T).fh, 0);
});

test("partial statusline keeps the other desktop window and newer desktop samples win", () => {
  const desktop = { timestamp: T - 1000, fh: 60, sd: 14 };
  const live = parseStatusline({ rate_limits: { five_hour: input.rate_limits.five_hour } }, T);
  const quota = buildClaudeQuota({ samples: [desktop, live], now: T });
  assert.equal(quota.primary.usedPercent, 73);
  assert.equal(quota.secondary.usedPercent, 14);
  assert.equal(quota.source, "mixed");
  const later = buildClaudeQuota({ samples: [desktop, live, { timestamp: T + 1000, fh: 80, sd: 18 }], now: T + 1000 });
  assert.equal(later.primary.usedPercent, 80);
  assert.equal(later.source, "plan-usage-history");
});

test("journal tolerates partial writes, missing windows, and cached statusline reruns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-status-test-"));
  const file = path.join(dir, "samples.jsonl");
  try {
    assert.equal(readStatusline(file, T).samples.length, 0);
    captureStatusline(input, { file, now: T });
    captureStatusline(input, { file, now: T + 1000 });
    captureStatusline({}, { file, now: T + 2000 });
    fs.appendFileSync(file, '{broken}\n');
    const read = readStatusline(file, T + 3000);
    assert.equal(read.samples.length, 1);
    assert.equal(read.samples[0].timestamp, T);
    assert.equal(read.samples[0].fh, 73);
    assert.equal(readStatusline(file, T + 36 * 86_400_000).samples.length, 0);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a new official window is recognized even when its utilization did not drop", () => {
  const a = parseStatusline(input, T);
  const b = { ...a, timestamp: reset + 1000, fhResetsAt: reset + 5 * 3600_000, fh: 80 };
  const quota = buildClaudeQuota({ samples: [a, b], now: b.timestamp });
  assert.equal(quota.primary.resetsAt, b.fhResetsAt);
  assert.equal(quota.primary.usedPercent, 80);
});
