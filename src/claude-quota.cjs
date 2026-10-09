const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The Claude desktop app samples the account's plan usage every 15 minutes
// into a local file: `fh` is the five-hour window and `sd` the seven-day one,
// both as integer percentages. The file carries no reset times or dollar
// amounts, so windows are inferred from the samples and capacity is fitted
// against locally logged Claude Code usage.
const CLAUDE_WINDOWS = [
  { key: "fh", minutes: 300, pool: "claude-300", slot: "primary", name: "5 小时额度" },
  { key: "sd", minutes: 10_080, pool: "claude-10080", slot: "secondary", name: "7 天额度" },
];
const STALE_AFTER_MS = 45 * 60_000;
const FIT_LOOKBACK_MS = 30 * 86_400_000;
const MIN_FIT_PERCENT = 5;
// Both interval endpoints are integers of unknown rounding.
const ROUNDING_PERCENT = 1;

// A launcher can override APPDATA, so also try Electron's own AppData
// folder (passed down by the main process) and the per-user default.
function claudeAppDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  const roots = platform === "win32"
    ? [env.WIDGET_SYSTEM_APPDATA, env.APPDATA, path.join(home, "AppData", "Roaming")]
    : [env.XDG_CONFIG_HOME, path.join(home, ".config")];
  const candidates = [...new Set(roots.filter(Boolean).map((root) => path.join(root, "Claude")))];
  // Store/MSIX installs virtualize Roaming AppData inside their package.
  // Other processes must read the physical LocalCache path.
  if (platform === "win32") {
    const localRoots = [...new Set([env.LOCALAPPDATA, path.join(home, "AppData", "Local")].filter(Boolean))];
    for (const root of localRoots) {
      const packages = path.join(root, "Packages");
      try {
        for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
          if (entry.isDirectory() && /^Claude_[a-z0-9]+$/i.test(entry.name)) {
            candidates.push(path.join(packages, entry.name, "LocalCache", "Roaming", "Claude"));
          }
        }
      } catch {
        // Non-Store installs may have no accessible Packages directory.
      }
    }
  }
  // An old install can leave a history file behind; prefer the active writer.
  const existing = candidates.flatMap((dir) => {
    try {
      const stat = fs.statSync(path.join(dir, "plan-usage-history.json"));
      return stat.isFile() ? [{ dir, modified: stat.mtimeMs }] : [];
    } catch { return []; }
  });
  existing.sort((a, b) => b.modified - a.modified);
  return existing[0]?.dir || candidates[0];
}

function planUsagePath() {
  return path.join(claudeAppDataDir(), "plan-usage-history.json");
}

function percent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

// Samples from other organizations (a different signed-in account) are ignored.
function readPlanUsage(file = planUsagePath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { available: false, file, samples: [], error: error.code === "ENOENT" ? null : error.message };
  }
  const all = (Array.isArray(raw?.samples) ? raw.samples : [])
    .map((sample) => ({ timestamp: Number(sample?.t), org: sample?.org ?? null, fh: percent(sample?.u?.fh), sd: percent(sample?.u?.sd) }))
    .filter((sample) => Number.isFinite(sample.timestamp) && (sample.fh != null || sample.sd != null))
    .sort((a, b) => a.timestamp - b.timestamp);
  const org = all.at(-1)?.org ?? null;
  return { available: all.length > 0, file, org, samples: all.filter((sample) => sample.org === org), error: null };
}

function toQuotaSamples(samples) {
  return samples.flatMap((sample) => CLAUDE_WINDOWS
    .filter((window) => sample[window.key] != null)
    .map((window) => ({ source: "claude", pool: window.pool, timestamp: sample.timestamp,
      usedPercent: sample[window.key], windowMinutes: window.minutes,
      ...(sample[`${window.key}ResetsAt`] != null ? { resetsAt: sample[`${window.key}ResetsAt`] } : {}) })));
}

// Merge stored per-pool rows back into one record per sampling time.
function fromQuotaSamples(rows) {
  const byTime = new Map();
  for (const row of rows) {
    const window = CLAUDE_WINDOWS.find((item) => item.pool === row.pool);
    if (!window || row.source !== "claude") continue;
    const record = byTime.get(row.timestamp) || { timestamp: row.timestamp, fh: null, sd: null };
    record[window.key] = percent(row.usedPercent);
    if (row.resetsAt != null) record[`${window.key}ResetsAt`] = row.resetsAt;
    byTime.set(row.timestamp, record);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function costIndex(events) {
  const rows = events
    .filter((event) => Number.isFinite(event.timestamp) && Number.isFinite(event.equivalentCostCents))
    .map((event) => ({ t: event.timestamp, cents: event.equivalentCostCents }))
    .sort((a, b) => a.t - b.t);
  const prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1) + row.cents);
  const upper = (time) => {
    let low = 0, high = rows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rows[mid].t <= time) low = mid + 1; else high = mid;
    }
    return low;
  };
  return {
    // Cost of events in (from, to].
    between: (from, to) => prefix[upper(to)] - prefix[upper(from)],
    firstAfter: (from, to) => {
      const index = upper(from);
      return index < rows.length && rows[index].t <= to ? rows[index].t : null;
    },
  };
}

// A window starts with the first usage after the previous one ended. Samples
// only bound that moment, so the start is the midpoint of the known interval,
// narrowed by the first locally logged request in it.
function inferWindows(samples, window, costs) {
  const durationMs = window.minutes * 60_000;
  const windows = [];
  const membership = new Map();
  let current = null;
  let previous = null;
  for (const sample of samples) {
    const value = sample[window.key];
    if (value == null) continue;
    const officialReset = sample[`${window.key}ResetsAt`];
    if (officialReset != null) {
      if (!current || current.resetsAt !== officialReset) {
        current = { id: windows.length, startLow: officialReset - durationMs,
          startHigh: officialReset - durationMs, startAt: officialReset - durationMs,
          resetsAt: officialReset, resetsLow: officialReset, resetsHigh: officialReset,
          firstSampleAt: sample.timestamp, points: [] };
        windows.push(current);
      }
      current.points.push({ timestamp: sample.timestamp, usedPercent: value });
      membership.set(sample.timestamp, current.id);
      previous = { timestamp: sample.timestamp, value };
      continue;
    }
    if (current && current.resetsHigh != null && sample.timestamp >= current.resetsHigh) current = null;
    if (value === 0) {
      current = null;
    } else if (!current || (previous && value < previous.value)) {
      let low = previous ? previous.timestamp : null;
      if (low != null && windows.at(-1)?.resetsLow != null) low = Math.max(low, Math.min(windows.at(-1).resetsLow, sample.timestamp));
      let high = sample.timestamp;
      const firstLocal = low == null ? null : costs.firstAfter(low, high);
      if (firstLocal != null) high = firstLocal;
      const startAt = low == null ? null : low + (high - low) / 2;
      current = {
        id: windows.length,
        startLow: low,
        startHigh: high,
        startAt,
        resetsAt: startAt == null ? null : startAt + durationMs,
        resetsLow: low == null ? null : low + durationMs,
        resetsHigh: low == null ? null : high + durationMs,
        firstSampleAt: sample.timestamp,
        points: [],
      };
      windows.push(current);
    }
    if (current) {
      current.points.push({ timestamp: sample.timestamp, usedPercent: value });
      membership.set(sample.timestamp, current.id);
    }
    previous = { timestamp: sample.timestamp, value };
  }
  return { windows, membership };
}

// Change in a window's percentage over (a, b], or null when a reset makes
// the change unobservable.
function percentDelta(a, b, window, inferred) {
  const from = a[window.key];
  const to = b[window.key];
  if (from == null || to == null) return null;
  const idA = inferred.membership.get(a.timestamp);
  const idB = inferred.membership.get(b.timestamp);
  if (to === 0) return from === 0 ? 0 : null;
  if (idA != null && idA === idB) return to - from;
  // A fresh window that began inside the interval, after an idle zero reading.
  if (from === 0 && idB != null) return to;
  return null;
}

// Fit cents per percentage point with a ratio estimator. Intervals whose
// quota change disagrees with local spend are other usage on the same account
// (Cowork, claude.ai, other devices) or unbilled local usage, and are dropped.
function fitRate(intervals, key) {
  const usable = intervals.filter((item) => item[key] != null);
  const signal = usable.filter((item) => item[key] >= 2 && item.cents > 0);
  if (!signal.length) return { rate: null, clean: [] };
  const ratios = signal.map((item) => item.cents / item[key]).sort((a, b) => a - b);
  let rate = ratios[Math.floor(ratios.length / 2)];
  let clean = usable;
  for (let pass = 0; pass < 8; pass += 1) {
    clean = usable.filter((item) => {
      const expected = item.cents / rate;
      return Math.abs(item[key] - expected) <= ROUNDING_PERCENT * 1.5 + expected * 0.35;
    });
    const percentTotal = clean.reduce((sum, item) => sum + item[key], 0);
    const centsTotal = clean.reduce((sum, item) => sum + item.cents, 0);
    if (!(percentTotal > 0 && centsTotal > 0)) return { rate: null, clean: [] };
    const next = centsTotal / percentTotal;
    if (Math.abs(next - rate) < rate * 1e-4) { rate = next; break; }
    rate = next;
  }
  return { rate, clean };
}

function capacityEstimate(clean, key, intervals) {
  const percentTotal = clean.reduce((sum, item) => sum + item[key], 0);
  const centsTotal = clean.reduce((sum, item) => sum + item.cents, 0);
  // Each unbroken run of clean intervals carries one rounding error.
  const cleanSet = new Set(clean);
  let runs = 0;
  let inRun = false;
  for (const item of intervals) {
    const isClean = cleanSet.has(item);
    if (isClean && !inRun) runs += 1;
    inRun = isClean;
  }
  const error = runs * ROUNDING_PERCENT;
  const fitted = percentTotal >= MIN_FIT_PERCENT && centsTotal > 0;
  return {
    status: fitted ? "fitted" : percentTotal > 0 ? "insufficient" : "no-data",
    totalCents: percentTotal > 0 ? 100 * centsTotal / percentTotal : null,
    lowCents: percentTotal > 0 ? 100 * centsTotal / (percentTotal + error) : null,
    highCents: percentTotal - error > 0 ? 100 * centsTotal / (percentTotal - error) : null,
    fittedPercent: percentTotal,
    fittedCents: centsTotal,
    intervals: clean.length,
    runs,
  };
}

function fitCapacity(samples, events, now = Date.now()) {
  const recent = samples.filter((sample) => sample.timestamp >= now - FIT_LOOKBACK_MS);
  const costs = costIndex(events);
  const inferred = Object.fromEntries(CLAUDE_WINDOWS.map((window) => [window.key, inferWindows(recent, window, costs)]));
  const intervals = [];
  for (let i = 1; i < recent.length; i += 1) {
    const a = recent[i - 1];
    const b = recent[i];
    intervals.push({ from: a.timestamp, to: b.timestamp, cents: costs.between(a.timestamp, b.timestamp),
      fh: percentDelta(a, b, CLAUDE_WINDOWS[0], inferred.fh), sd: percentDelta(a, b, CLAUDE_WINDOWS[1], inferred.sd) });
  }
  // The five-hour window moves 30x faster than the weekly one, so it alone
  // decides which intervals are clean; the weekly fit reuses that choice.
  const five = fitRate(intervals, "fh");
  const clean = new Set(five.clean);
  const weeklyClean = intervals.filter((item) => clean.has(item) && item.sd != null);
  const excluded = intervals.filter((item) => item.fh != null && !clean.has(item));
  return {
    fiveHour: capacityEstimate(five.clean, "fh", intervals),
    weekly: capacityEstimate(weeklyClean, "sd", intervals),
    excludedIntervals: excluded.length,
    excludedPercent: excluded.reduce((sum, item) => sum + Math.max(0, item.fh - item.cents / (five.rate || Infinity)), 0),
    intervals: intervals.length,
    lookbackDays: FIT_LOOKBACK_MS / 86_400_000,
  };
}

// Stored samples carry no reset times; attach the inferred ones so the quota
// timeline can split cycles the same way it does for Codex.
function annotateQuotaSamples(rows, events = []) {
  const samples = fromQuotaSamples(rows);
  const costs = costIndex(events);
  const resets = new Map();
  for (const window of CLAUDE_WINDOWS) {
    const { windows } = inferWindows(samples, window, costs);
    for (const item of windows) {
      for (const point of item.points) resets.set(`${window.pool}:${point.timestamp}`, item);
    }
  }
  return rows.flatMap((row) => {
    if (row.source !== "claude") return [row];
    const item = resets.get(`${row.pool}:${row.timestamp}`);
    // A zero reading between windows belongs to no allowance.
    if (!item) return [];
    return [{ ...row, resetsAt: row.resetsAt ?? item.resetsAt ?? null, startsAt: item.startAt ?? null }];
  });
}

function buildClaudeQuota({ samples = [], events = [], now = Date.now(), speedUsage = () => null } = {}) {
  if (!samples.length) return null;
  const costs = costIndex(events);
  const fit = fitCapacity(samples, events, now);
  const latest = samples.at(-1);
  const stale = now - latest.timestamp > STALE_AFTER_MS;
  const windows = CLAUDE_WINDOWS.map((window) => {
    const latest = samples.findLast((sample) => sample[window.key] != null);
    if (!latest) return null;
    const { windows: inferred } = inferWindows(samples, window, costs);
    const last = inferred.at(-1);
    const sampledValue = latest[window.key];
    if (sampledValue == null) return null;
    const estimate = window.key === "fh" ? fit.fiveHour : fit.weekly;
    const active = last && last.points.at(-1)?.timestamp === latest.timestamp;
    const expired = active && last.resetsHigh != null && now >= last.resetsHigh;
    const usedPercent = active && !expired ? sampledValue : 0;
    const startAt = active && !expired ? last.startAt ?? last.startLow ?? last.firstSampleAt : null;
    const capacity = estimate.status === "fitted" ? estimate.totalCents : null;
    const localCents = startAt == null ? 0 : costs.between(startAt, latest.timestamp);
    const localPercent = capacity ? localCents / capacity * 100 : null;
    return {
      slot: window.slot,
      pool: window.pool,
      name: window.name,
      windowMinutes: window.minutes,
      usedPercent,
      officialUsedPercent: sampledValue,
      percentRemaining: 100 - usedPercent,
      sampledAt: latest.timestamp,
      startsAt: startAt,
      resetsAt: active && !expired ? last.resetsAt : null,
      resetsLow: active && !expired ? last.resetsLow : null,
      resetsHigh: active && !expired ? last.resetsHigh : null,
      resetEstimated: latest[`${window.key}ResetsAt`] == null,
      source: latest[`${window.key}ResetsAt`] == null ? "plan-usage-history" : "statusline",
      stale: now - latest.timestamp > STALE_AFTER_MS,
      expired: Boolean(expired),
      expiredAt: expired ? last.resetsAt : null,
      speedUsage: startAt == null ? null : speedUsage(startAt, now),
      quotaEstimate: {
        estimateStatus: estimate.status,
        inferredTotalCents: capacity,
        inferredTotalLowCents: capacity ? estimate.lowCents : null,
        inferredTotalHighCents: capacity ? estimate.highCents : null,
        usedCents: capacity ? capacity * usedPercent / 100 : null,
        inferredRemainingCents: capacity ? capacity * (100 - usedPercent) / 100 : null,
        localCents,
        localPercent,
        otherPercent: localPercent == null || startAt == null || last.startLow == null
          ? null : Math.max(0, usedPercent - localPercent),
      },
    };
  }).filter(Boolean);
  return {
    source: windows.every((window) => window.source === "statusline") ? "statusline"
      : windows.some((window) => window.source === "statusline") ? "mixed" : "plan-usage-history",
    sampledAt: latest.timestamp,
    stale,
    windows,
    primary: windows.find((window) => window.slot === "primary") || null,
    secondary: windows.find((window) => window.slot === "secondary") || null,
    fit,
  };
}

module.exports = {
  CLAUDE_WINDOWS,
  annotateQuotaSamples,
  buildClaudeQuota,
  claudeAppDataDir,
  fitCapacity,
  fromQuotaSamples,
  inferWindows,
  planUsagePath,
  readPlanUsage,
  toQuotaSamples,
};
