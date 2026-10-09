const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CLAUDE_WINDOWS, annotateQuotaSamples, buildClaudeQuota, fitCapacity, fromQuotaSamples,
  claudeAppDataDir, inferWindows, readPlanUsage, toQuotaSamples,
} = require("../src/claude-quota.cjs");
const { buildQuotaInsights } = require("../src/quota-insights.cjs");
const { buildQuotaTimeline, poolIdOf } = require("../src/quota-timeline.cjs");

const MIN = 60_000;
const T0 = Date.parse("2026-09-30T01:25:30+08:00");

test("Windows discovers Store samples and prefers them over an older regular install", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-path-"));
  try {
    const home = path.join(dir, "home");
    const options = { platform: "win32", home, env: { APPDATA: path.join(dir, "redirected") } };
    const regular = path.join(home, "AppData", "Roaming", "Claude");
    const store = path.join(home, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    assert.equal(claudeAppDataDir(options), path.join(options.env.APPDATA, "Claude"));
    fs.mkdirSync(regular, { recursive: true });
    const regularFile = path.join(regular, "plan-usage-history.json");
    fs.writeFileSync(regularFile, '{}');
    fs.utimesSync(regularFile, new Date(T0), new Date(T0));
    assert.equal(claudeAppDataDir(options), regular);
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "plan-usage-history.json"), JSON.stringify({ samples: [
      { t: T0, u: { fh: 73, sd: 16 } },
    ] }));
    fs.utimesSync(path.join(store, "plan-usage-history.json"), new Date(T0 + MIN), new Date(T0 + MIN));
    assert.equal(claudeAppDataDir(options), store);
    assert.equal(readPlanUsage(path.join(claudeAppDataDir(options), "plan-usage-history.json")).samples[0].fh, 73);
    fs.utimesSync(regularFile, new Date(T0 + 365 * 86_400_000), new Date(T0 + 365 * 86_400_000));
    assert.equal(claudeAppDataDir(options), regular);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real samples and local spend recorded on 2026-09-30: the first three
// intervals include usage from outside local Claude Code.
const REAL = [
  [0, 0, 0, 0], [15, 4, 1, 0], [30, 16, 4, 0], [45, 28, 7, 110], [60, 31, 8, 118], [75, 38, 9, 338],
  [150, 42, 10, 185], [165, 42, 10, 0], [180, 42, 10, 0], [195, 42, 10, 0], [213, 42, 10, 0],
  [228, 42, 10, 0], [243, 46, 11, 184], [258, 51, 12, 244], [273, 61, 14, 472],
];

function fixture(rows = REAL) {
  const samples = rows.map(([minute, fh, sd]) => ({ timestamp: T0 + minute * MIN, fh, sd }));
  const events = rows.filter(([, , , cents]) => cents > 0)
    .map(([minute, , , cents], index) => ({ source: "claude", timestamp: T0 + minute * MIN - 2 * MIN,
      equivalentCostCents: cents, eventKey: `e${index}` }));
  return { samples, events };
}

test("capacity fit drops intervals that include usage from other clients", () => {
  const { samples, events } = fixture();
  const fit = fitCapacity(samples, events, T0 + 280 * MIN);
  assert.equal(fit.excludedIntervals, 3);
  assert.equal(fit.fiveHour.status, "fitted");
  assert.equal(fit.fiveHour.fittedPercent, 33);
  assert.ok(Math.abs(fit.fiveHour.totalCents - 154100 / 33) < 1e-6);
  assert.ok(fit.fiveHour.lowCents < fit.fiveHour.totalCents && fit.fiveHour.totalCents < fit.fiveHour.highCents);
  assert.equal(fit.weekly.fittedPercent, 7);
  assert.ok(Math.abs(fit.weekly.totalCents - 154100 / 7) < 1e-6);
  assert.ok(Math.abs(fit.weekly.lowCents - 154100 / 8) < 1e-6);
  assert.ok(Math.abs(fit.weekly.highCents - 154100 / 6) < 1e-6);
});

test("too little movement is reported as insufficient rather than fitted", () => {
  const { samples, events } = fixture(REAL.slice(3, 6));
  const fit = fitCapacity(samples, events, T0 + 80 * MIN);
  assert.equal(fit.weekly.status, "insufficient");
  assert.equal(buildClaudeQuota({ samples, events, now: T0 + 80 * MIN }).secondary.quotaEstimate.inferredTotalCents, null);
});

test("a window starts between the last idle reading and the first local request", () => {
  const { samples } = fixture();
  const window = CLAUDE_WINDOWS[0];
  const costs = { firstAfter: () => T0 + 10 * MIN };
  const { windows } = inferWindows(samples, window, { ...costs, between: () => 0 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startLow, T0);
  assert.equal(windows[0].startHigh, T0 + 10 * MIN);
  assert.equal(windows[0].resetsAt, T0 + 5 * MIN + 300 * MIN);
});

test("a drop in the percentage starts a new window; unknown starts stay unknown", () => {
  const samples = [
    { timestamp: T0, fh: 40, sd: 5 },
    { timestamp: T0 + 15 * MIN, fh: 55, sd: 6 },
    { timestamp: T0 + 310 * MIN, fh: 3, sd: 6 },
  ];
  const noLocal = { firstAfter: () => null, between: () => 0 };
  const { windows } = inferWindows(samples, CLAUDE_WINDOWS[0], noLocal);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].resetsAt, null);
  assert.equal(windows[1].startLow, T0 + 15 * MIN);
});

test("current windows expire once their latest possible reset has passed", () => {
  const { samples, events } = fixture();
  const live = buildClaudeQuota({ samples, events, now: T0 + 280 * MIN });
  assert.equal(live.primary.usedPercent, 61);
  assert.equal(live.primary.expired, false);
  assert.ok(live.primary.quotaEstimate.otherPercent > 20);
  const later = buildClaudeQuota({ samples, events, now: T0 + 6 * 60 * MIN });
  assert.equal(later.primary.expired, true);
  assert.equal(later.primary.usedPercent, 0);
  assert.equal(later.primary.resetsAt, null);
  assert.equal(later.secondary.expired, false);
  assert.equal(later.stale, true);
});

test("plan usage file keeps only the signed-in organization", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plan-"));
  try {
    const file = path.join(dir, "plan-usage-history.json");
    fs.writeFileSync(file, JSON.stringify({ version: 2, samples: [
      { t: T0, org: "old", u: { fh: 90, sd: 50 } },
      { t: T0 + MIN, org: "new", u: { fh: 4, sd: 1 } },
      { t: T0 + 2 * MIN, org: "new", u: {} },
    ] }));
    const plan = readPlanUsage(file);
    assert.equal(plan.org, "new");
    assert.deepEqual(plan.samples.map((sample) => sample.fh), [4]);
    assert.deepEqual(readPlanUsage(path.join(dir, "missing.json")), { available: false, file: path.join(dir, "missing.json"), samples: [], error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stored samples round-trip and gain inferred resets for the timeline", () => {
  const { samples, events } = fixture();
  const rows = toQuotaSamples(samples);
  assert.equal(rows.length, samples.length * 2);
  assert.deepEqual(fromQuotaSamples(rows), samples);
  const annotated = annotateQuotaSamples(rows, events);
  // The idle 0% reading before the window belongs to no cycle.
  assert.equal(annotated.length, rows.length - 2);
  assert.ok(annotated.every((row) => row.resetsAt > row.timestamp));
  assert.equal(poolIdOf(annotated[0]), annotated[0].pool);
  const timeline = buildQuotaTimeline(annotated, { pool: "claude-300", now: T0 + 280 * MIN });
  assert.equal(timeline.pool, "claude-300");
  assert.equal(timeline.cycles.length, 1);
  assert.equal(timeline.cycle.current, true);
  assert.equal(timeline.cycle.interrupted, false);
  assert.equal(timeline.cycle.reference.estimated, true);
});

test("quota insights forecast Claude windows", () => {
  const { samples, events } = fixture();
  const quota = buildClaudeQuota({ samples, events, now: T0 + 280 * MIN });
  const insights = buildQuotaInsights({ claude: { quota } }, T0 + 280 * MIN);
  assert.deepEqual(insights.map((item) => item.id), ["claude-300", "claude-10080"]);
  assert.equal(insights[0].remainingPercent, 39);
  assert.ok(["safe", "exhaust"].includes(insights[0].forecast.status));
});
