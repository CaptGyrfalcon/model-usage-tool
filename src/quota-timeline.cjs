const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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

function formatCycleRange(startAt, endAt, typicalMs) {
  const start = finite(startAt);
  const end = finite(endAt);
  if (start == null && end == null) return "未知周期";
  const short = typicalMs <= 12 * HOUR_MS;
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
    });
  }
  if (data.otherModels) {
    points.push({
      source: "cursor",
      pool: "other-models",
      timestamp: at,
      usedPercent: data.otherModels.percentUsed,
      resetsAt: data.billingCycleEnd,
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

function groupCycles(samples, poolId, now = Date.now()) {
  const meta = poolMeta(poolId);
  const filtered = samples
    .map(normalizeSample)
    .filter((sample) => sample && poolIdOf(sample) === poolId)
    .sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map();
  let previous = null;
  for (const sample of filtered) {
    const cycleKey = assignCycleKey(sample, previous, meta.typicalMs);
    const tagged = { ...sample, cycleKey };
    if (!groups.has(cycleKey)) groups.set(cycleKey, []);
    groups.get(cycleKey).push(tagged);
    previous = tagged;
  }

  return [...groups.entries()].map(([key, points]) => {
    const first = points[0];
    const last = points[points.length - 1];
    const endAt = last.resetsAt || last.timestamp;
    const startAt = first.resetsAt != null
      ? Math.min(first.timestamp, first.resetsAt - meta.typicalMs)
      : first.timestamp;
    const current = last.resetsAt != null ? last.resetsAt > now : now - last.timestamp < meta.typicalMs;
    return {
      key,
      pool: poolId,
      label: formatCycleRange(startAt, endAt, meta.typicalMs),
      startAt,
      endAt,
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
  }).sort((a, b) => (b.endAt || 0) - (a.endAt || 0));
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

function mergeLivePoint(cycle, live, poolId) {
  const point = live.map(normalizeSample).find((sample) => sample && poolIdOf(sample) === poolId);
  if (!point || point.remainingPercent == null) return cycle;
  const last = cycle.points[cycle.points.length - 1];
  if (last && point.timestamp <= last.at) {
    return {
      ...cycle,
      endRemaining: point.remainingPercent,
      points: cycle.points.map((item, index) => (
        index === cycle.points.length - 1
          ? { at: point.timestamp, usedPercent: point.usedPercent, remainingPercent: point.remainingPercent }
          : item
      )),
    };
  }
  return {
    ...cycle,
    endAt: Math.max(cycle.endAt || 0, point.resetsAt || point.timestamp),
    endRemaining: point.remainingPercent,
    points: [...cycle.points, {
      at: point.timestamp,
      usedPercent: point.usedPercent,
      remainingPercent: point.remainingPercent,
    }],
  };
}

function buildQuotaTimeline(samples, {
  pool = "cursor-models",
  cycleKey = null,
  now = Date.now(),
  live = [],
} = {}) {
  const available = QUOTA_POOLS.filter((item) => groupCycles(samples, item.id, now).length || live.some((point) => poolIdOf(normalizeSample(point) || {}) === item.id));
  const poolId = available.some((item) => item.id === pool) ? pool : (available[0]?.id || pool);
  const cycles = groupCycles(samples, poolId, now);
  const liveForPool = live.map(normalizeSample).filter((sample) => sample && poolIdOf(sample) === poolId);
  if (liveForPool.length && (!cycles.length || !cycles.some((cycle) => cycle.current))) {
    const point = liveForPool[liveForPool.length - 1];
    const meta = poolMeta(poolId);
    cycles.unshift({
      key: point.resetsAt != null ? `reset:${point.resetsAt}` : `open:${point.timestamp}`,
      pool: poolId,
      label: formatCycleRange(point.timestamp, point.resetsAt, meta.typicalMs),
      startAt: point.timestamp,
      endAt: point.resetsAt || point.timestamp,
      current: true,
      sampleCount: 1,
      startRemaining: point.remainingPercent,
      endRemaining: point.remainingPercent,
      points: [{ at: point.timestamp, usedPercent: point.usedPercent, remainingPercent: point.remainingPercent }],
    });
  }

  const selected = cycles.find((cycle) => cycle.key === cycleKey) || cycles.find((cycle) => cycle.current) || cycles[0] || null;
  const merged = selected ? mergeLivePoint(selected, live, poolId) : null;
  const series = downsample(merged?.points || []).filter((point) => point.remainingPercent != null);
  return {
    pools: QUOTA_POOLS.map((item) => ({
      ...item,
      hasData: available.some((entry) => entry.id === item.id),
    })),
    pool: poolId,
    cycles: cycles.map((cycle) => ({
      key: cycle.key,
      label: cycle.current ? `当前 · ${cycle.label}` : cycle.label,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      current: cycle.current,
      sampleCount: cycle.sampleCount,
    })),
    cycle: merged ? {
      key: merged.key,
      label: merged.current ? `当前 · ${merged.label}` : merged.label,
      startAt: merged.startAt,
      endAt: merged.endAt,
      current: merged.current,
      startRemaining: merged.startRemaining,
      endRemaining: merged.endRemaining,
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
