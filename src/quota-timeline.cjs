const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Session records and reset-after response headers can disagree by seconds.
const CODEX_RESET_TOLERANCE_MS = 60_000;

const QUOTA_POOLS = [
  { id: "cursor-models", source: "cursor", label: "Cursor 模型池", typicalMs: 30 * DAY_MS },
  { id: "other-models", source: "cursor", label: "Cursor 三方模型池", typicalMs: 30 * DAY_MS },
  { id: "codex-300", source: "codex", label: "Codex 5 小时", typicalMs: 5 * HOUR_MS },
  { id: "codex-10080", source: "codex", label: "Codex 每周", typicalMs: 7 * DAY_MS },
];

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finite(value);
  return number == null ? null : Math.min(100, Math.max(0, number));
}

function remainingOf(usedPercent) {
  const used = clampPercent(usedPercent);
  return used == null ? null : Math.round((100 - used) * 100) / 100;
}

function windowMinutesOf(sample) {
  const listed = finite(sample?.windowMinutes);
  if (listed != null) return listed;
  const match = String(sample?.pool || "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function poolIdOf(sample) {
  if (sample?.source === "cursor") {
    return sample.pool === "cursor-models" ? "cursor-models" : "other-models";
  }
  const minutes = windowMinutesOf(sample);
  if (minutes != null && minutes <= 360) return "codex-300";
  if (minutes != null && minutes >= 6 * 24 * 60) return "codex-10080";
  if (minutes != null) return `codex-${minutes}`;
  return String(sample?.pool || "unknown");
}

function poolMeta(poolId) {
  return QUOTA_POOLS.find((item) => item.id === poolId) || {
    id: poolId,
    source: String(poolId).startsWith("codex") ? "codex" : "cursor",
    label: poolId,
    typicalMs: DAY_MS,
  };
}

function formatCycleRange(startAt, endAt, typicalMs, includeTime = false) {
  const start = finite(startAt);
  const end = finite(endAt);
  if (start == null && end == null) return "未知周期";
  const short = includeTime || typicalMs <= 12 * HOUR_MS
    || (start != null && end != null && new Date(start).toDateString() === new Date(end).toDateString());
  const stamp = (value) => {
    const date = new Date(value);
    const month = `${date.getMonth() + 1}月${date.getDate()}日`;
    if (!short) return month;
    return `${month} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  if (start != null && end != null) return `${stamp(start)} – ${stamp(end)}`;
  if (end != null) return `至 ${stamp(end)}`;
  return `${stamp(start)} 起`;
}

function normalizeSample(raw) {
  const timestamp = finite(raw?.timestamp) ?? finite(raw?.bucket);
  if (timestamp == null) return null;
  const usedPercent = clampPercent(raw.usedPercent ?? raw.used_percent);
  return {
    source: String(raw.source || ""),
    pool: String(raw.pool || ""),
    timestamp,
    usedPercent,
    remainingPercent: remainingOf(usedPercent),
    windowMinutes: windowMinutesOf(raw),
    resetsAt: finite(raw.resetsAt ?? raw.resets_at),
    startsAt: finite(raw.startsAt),
  };
}

function livePointsFromSnapshot(data, now = Date.now()) {
  if (!data) return [];
  const at = finite(data.fetchedAt) || now;
  const points = [];
  if (data.cursorModels) {
    points.push({
      source: "cursor",
      pool: "cursor-models",
      timestamp: at,
      usedPercent: data.cursorModels.percentUsed,
      resetsAt: data.billingCycleEnd,
      startsAt: data.billingCycleStart,
    });
  }
  if (data.otherModels) {
    points.push({
      source: "cursor",
      pool: "other-models",
      timestamp: at,
      usedPercent: data.otherModels.percentUsed,
      resetsAt: data.billingCycleEnd,
      startsAt: data.billingCycleStart,
    });
  }
  const windows = Array.isArray(data.codex?.quota?.windows) && data.codex.quota.windows.length
    ? data.codex.quota.windows
    : [data.codex?.quota?.primary, data.codex?.quota?.secondary].filter(Boolean);
  for (const window of windows) {
    points.push({
      source: "codex",
      pool: `${window.slot || "window"}-${window.windowMinutes}`,
      timestamp: at,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetsAt: window.resetsAt,
    });
  }
  return points.map(normalizeSample).filter(Boolean);
}

function assignCycleKey(sample, previous, typicalMs) {
  if (sample.resetsAt != null) return `reset:${sample.resetsAt}`;
  if (!previous) return `open:${sample.timestamp}`;
  const drop = (previous.usedPercent ?? 0) - (sample.usedPercent ?? 0);
  const gap = sample.timestamp - previous.timestamp;
  if (drop >= 12 || gap > typicalMs * 1.25) return `open:${sample.timestamp}`;
  return previous.cycleKey;
}

function resetMatches(key, resetAt, poolId) {
  if (resetAt == null || !key.startsWith("reset:")) return false;
  const tolerance = poolId.startsWith("codex") ? CODEX_RESET_TOLERANCE_MS : 0;
  return Math.abs(Number(key.slice(6)) - resetAt) <= tolerance;
}

function groupCycles(samples, poolId, now = Date.now()) {
  const meta = poolMeta(poolId);
  const filtered = samples
    .map(normalizeSample)
    .filter((sample) => sample && poolIdOf(sample) === poolId && sample.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map();
  let previous = null;
  for (const sample of filtered) {
    // Compare to a fixed group anchor, not the preceding sample, so small
    // successive changes cannot chain unrelated reset dates into one cycle.
    const cycleKey = [...groups.keys()].find((key) => resetMatches(key, sample.resetsAt, poolId))
      || assignCycleKey(sample, previous, meta.typicalMs);
    const tagged = { ...sample, cycleKey };
    if (!groups.has(cycleKey)) groups.set(cycleKey, []);
    groups.get(cycleKey).push(tagged);
    previous = tagged;
  }

  const cycles = [...groups.entries()].map(([key, observations]) => {
    // Live data supersedes a stored observation at the same timestamp.
    const points = [...new Map(observations.map((point) => [point.timestamp, point])).values()];
    const first = points[0];
    const last = points[points.length - 1];
    const endAt = last.resetsAt || last.timestamp;
    const startAt = last.resetsAt != null
      ? Math.min(first.timestamp, last.resetsAt - meta.typicalMs)
      : first.timestamp;
    // Early resets can leave several old deadlines in the future. Only the
    // cycle from the latest observation can still be active.
    const current = key === previous?.cycleKey
      && (last.resetsAt != null ? last.resetsAt > now : now - last.timestamp < meta.typicalMs);
    return {
      key,
      pool: poolId,
      label: formatCycleRange(startAt, endAt, meta.typicalMs),
      startAt,
      endAt,
      firstObservedAt: first.timestamp,
      windowMinutes: last.windowMinutes,
      current,
      sampleCount: points.length,
      startRemaining: first.remainingPercent,
      endRemaining: last.remainingPercent,
      points: points.map((point) => ({
        at: point.timestamp,
        usedPercent: point.usedPercent,
        remainingPercent: point.remainingPercent,
      })),
    };
  });
  if (meta.source === "codex") closeCodexCycles(cycles, now);
  return cycles.sort((a, b) => (b.endAt || 0) - (a.endAt || 0));
}

function closeCodexCycles(cycles, now) {
  // First appearances establish the sequence of allowances. Later cached
  // observations of an old reset date must not reopen a superseded cycle.
  cycles.sort((a, b) => a.firstObservedAt - b.firstObservedAt);
  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i];
    cycle.scheduledEndAt = cycle.endAt;
    if (cycle.key.startsWith("reset:")) {
      const duration = cycle.windowMinutes > 0 ? cycle.windowMinutes * 60_000 : poolMeta(cycle.pool).typicalMs;
      cycle.startAt = Math.min(cycle.firstObservedAt, cycle.scheduledEndAt - duration);
    }
    if (i && cycle.startAt <= cycles[i - 1].startAt) {
      // A corrected deadline can move backwards. In that case it cannot
      // establish an earlier new allowance; use its first observation.
      cycle.startAt = cycle.firstObservedAt;
    }
  }
  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i];
    const next = cycles[i + 1];
    cycle.endAt = Math.min(cycle.scheduledEndAt, next?.startAt ?? Infinity);
    cycle.interrupted = cycle.endAt < cycle.scheduledEndAt - CODEX_RESET_TOLERANCE_MS;
    cycle.current = !next && cycle.current;
    // Keep only observations inside the actual allowance. In particular,
    // cached old-window snapshots after an early reset are not old usage.
    cycle.points = cycle.points.filter((point) => point.at >= cycle.startAt && point.at <= cycle.endAt
      && (!next || point.at < next.startAt));
    cycle.sampleCount = cycle.points.length;
    cycle.startRemaining = cycle.points[0]?.remainingPercent ?? null;
    cycle.endRemaining = cycle.points.at(-1)?.remainingPercent ?? null;
    // Unlike an old cached record, the last newly observed window owns the
    // current state even when an earlier window was sampled more recently.
    if (!next && cycle.key.startsWith("reset:")) cycle.current = cycle.endAt > now;
    cycle.label = formatCycleRange(cycle.startAt, cycle.endAt, poolMeta(cycle.pool).typicalMs);
  }
}

function downsample(points, maxPoints = 200) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const picked = [];
  let lastIndex = -1;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * step);
    if (index === lastIndex) continue;
    picked.push(points[index]);
    lastIndex = index;
  }
  return picked;
}

function extendCompletedCycle(cycle, points, now) {
  // A superseded cycle may retain a future scheduled deadline. Do not draw
  // its old water level into the future as though it were still active.
  if (!cycle || cycle.current || cycle.endAt > now || !points.length) return points;
  const last = points[points.length - 1];
  if (!Number.isFinite(cycle.endAt) || cycle.endAt <= last.at) return points;
  return [...points, {
    at: cycle.endAt,
    usedPercent: last.usedPercent,
    remainingPercent: last.remainingPercent,
    projected: true,
  }];
}

function cycleReference(cycle, samples, poolId) {
  if (!cycle?.key.startsWith("reset:")) return null;
  const endAt = cycle.endAt;
  if (!Number.isFinite(endAt)) return null;
  const points = samples.map(normalizeSample).filter((point) => point && poolIdOf(point) === poolId);
  const matching = points.filter((point) => resetMatches(cycle.key, point.resetsAt, poolId));
  if (poolId.startsWith("codex")) {
    const minutes = matching.findLast((point) => point.windowMinutes > 0)?.windowMinutes;
    return { startAt: cycle.startAt, endAt, estimated: !minutes };
  }
  const explicit = matching.findLast((point) => point.startsAt != null && point.startsAt < endAt);
  if (explicit) return { startAt: explicit.startsAt, endAt, estimated: false };
  const previousEnd = points.reduce((latest, point) => point.resetsAt < endAt && point.resetsAt <= cycle.points[0]?.at ? Math.max(latest, point.resetsAt || 0) : latest, 0);
  const duration = endAt - previousEnd;
  if (poolId.startsWith("cursor") || poolId === "other-models") {
    if (previousEnd && duration >= 27 * DAY_MS && duration <= 32 * DAY_MS) return { startAt: previousEnd, endAt, estimated: false };
  }
  return { startAt: endAt - poolMeta(poolId).typicalMs, endAt, estimated: true };
}

function buildQuotaTimeline(samples, {
  pool = "cursor-models",
  cycleKey = null,
  now = Date.now(),
  live = [],
} = {}) {
  // Include live data before grouping: an early reset may not be persisted yet.
  const observations = [...samples, ...live.filter((point) => normalizeSample(point)?.remainingPercent != null)];
  const grouped = new Map(QUOTA_POOLS.map((item) => [item.id, groupCycles(observations, item.id, now)]));
  const available = QUOTA_POOLS.filter((item) => grouped.get(item.id).length);
  const poolId = available.some((item) => item.id === pool) ? pool : (available[0]?.id || pool);
  const cycles = (grouped.get(poolId) || []).map((cycle) => {
    const reference = cycleReference(cycle, observations, poolId);
    const startAt = reference?.startAt ?? cycle.startAt;
    return { ...cycle, startAt, reference,
      label: formatCycleRange(startAt, cycle.endAt, poolMeta(poolId).typicalMs) };
  });
  // Real resets on the same date remain separate, with times to tell them apart.
  const labelCounts = new Map();
  for (const cycle of cycles) labelCounts.set(cycle.label, (labelCounts.get(cycle.label) || 0) + 1);
  for (const cycle of cycles) {
    if (labelCounts.get(cycle.label) > 1) {
      cycle.label = formatCycleRange(cycle.startAt, cycle.endAt, poolMeta(poolId).typicalMs, true);
    }
  }
  const requestedReset = String(cycleKey).startsWith("reset:") ? Number(cycleKey.slice(6)) : null;
  const selected = cycles.find((cycle) => cycle.key === cycleKey)
    || cycles.find((cycle) => resetMatches(cycle.key, requestedReset, poolId))
    || cycles.find((cycle) => cycle.current) || cycles[0] || null;
  const reference = selected?.reference;
  const cycleLabel = (cycle) => cycle.current ? `当前 · ${cycle.label}`
    : `${cycle.label}${cycle.interrupted ? "（提前重置）" : ""}`;
  const sampled = downsample((selected?.points || []).filter((point) => point.remainingPercent != null));
  const series = extendCompletedCycle(selected, sampled, now);
  return {
    pools: QUOTA_POOLS.map((item) => ({
      ...item,
      hasData: available.some((entry) => entry.id === item.id),
    })),
    pool: poolId,
    cycles: cycles.map((cycle) => ({
      key: cycle.key,
      label: cycleLabel(cycle),
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      scheduledEndAt: cycle.scheduledEndAt,
      interrupted: Boolean(cycle.interrupted),
      current: cycle.current,
      sampleCount: cycle.sampleCount,
    })),
    cycle: selected ? {
      key: selected.key,
      label: cycleLabel(selected),
      startAt: reference?.startAt ?? selected.startAt,
      endAt: selected.endAt,
      scheduledEndAt: selected.scheduledEndAt,
      interrupted: Boolean(selected.interrupted),
      current: selected.current,
      startRemaining: selected.startRemaining,
      endRemaining: selected.endRemaining,
      reference,
    } : null,
    series,
  };
}

module.exports = {
  QUOTA_POOLS,
  assignCycleKey,
  buildQuotaTimeline,
  downsample,
  groupCycles,
  livePointsFromSnapshot,
  poolIdOf,
  remainingOf,
};
