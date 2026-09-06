const MIN_FORECAST_WINDOW_MS = 5 * 60_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finite(value);
  return number == null ? null : Math.min(100, Math.max(0, number));
}

function forecastQuota({ usedPercent, startAt, resetsAt }, now = Date.now()) {
  const used = clampPercent(usedPercent);
  const start = finite(startAt);
  const reset = finite(resetsAt);
  if (used == null || start == null || reset == null || reset <= now) return { status: "unknown", exhaustionAt: null };
  const elapsed = now - start;
  if (used < 0.5 || elapsed < MIN_FORECAST_WINDOW_MS) return { status: "unknown", exhaustionAt: null };
  if (used >= 100) return { status: "exhaust", exhaustionAt: now };
  const exhaustionAt = now + elapsed * (100 - used) / used;
  return exhaustionAt < reset
    ? { status: "exhaust", exhaustionAt: Math.round(exhaustionAt) }
    : { status: "safe", exhaustionAt: Math.round(exhaustionAt) };
}

function codexWindows(codex) {
  const windows = Array.isArray(codex?.quota?.windows) && codex.quota.windows.length
    ? codex.quota.windows
    : [codex?.quota?.primary, codex?.quota?.secondary].filter(Boolean);
  return windows.slice().sort((a, b) => (finite(a.windowMinutes) || Infinity) - (finite(b.windowMinutes) || Infinity));
}

function codexLabel(window, index, total) {
  const minutes = finite(window?.windowMinutes);
  if (minutes != null && minutes <= 360) return "Codex 5 小时";
  if (minutes != null && minutes >= 6 * 24 * 60) return "Codex 每周";
  if (window?.name) return `Codex ${window.name}`;
  return total > 1 ? `Codex 窗口 ${index + 1}` : "Codex";
}

function buildQuotaInsights(data, now = Date.now()) {
  if (!data) return [];
  const insights = [];
  const cursorPools = [
    { id: "cursor-models", label: "Cursor 模型池", pool: data.cursorModels },
    { id: "cursor-api", label: "Cursor API 池", pool: data.otherModels },
  ].filter((item) => item.pool);
  const cursorResetsAt = finite(data.billingCycleEnd);
  const cursorStartAt = finite(data.billingCycleStart);
  cursorPools.forEach(({ id, label, pool }) => {
    const usedPercent = clampPercent(pool.percentUsed);
    const remainingPercent = clampPercent(pool.percentRemaining) ?? (usedPercent == null ? null : Math.max(0, 100 - usedPercent));
    insights.push({
      id,
      label,
      usedPercent,
      remainingPercent,
      resetsAt: cursorResetsAt,
      forecast: forecastQuota({ usedPercent, startAt: cursorStartAt, resetsAt: cursorResetsAt }, now),
    });
  });

  const windows = codexWindows(data.codex);
  windows.forEach((window, index) => {
    const windowMinutes = finite(window.windowMinutes);
    const resetsAt = finite(window.resetsAt);
    const usedPercent = clampPercent(window.usedPercent) ?? (100 - (clampPercent(window.percentRemaining) ?? 100));
    insights.push({
      id: windowMinutes != null ? `codex-${windowMinutes}` : `codex-${window.slot || index}`,
      label: codexLabel(window, index, windows.length),
      usedPercent,
      remainingPercent: clampPercent(window.percentRemaining) ?? Math.max(0, 100 - usedPercent),
      resetsAt,
      forecast: forecastQuota({
        usedPercent,
        startAt: resetsAt != null && windowMinutes != null ? resetsAt - windowMinutes * 60_000 : null,
        resetsAt,
      }, now),
    });
  });
  if (data.codex && data.codex.quota?.shortLimit !== "absent" && !insights.some((item) => item.id === "codex-300")) {
    insights.push({
      id: "codex-300",
      label: "Codex 5 小时",
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      forecast: { status: "unknown", exhaustionAt: null },
      pending: true,
    });
  }
  if (data.codex && !insights.some((item) => item.id === "codex-10080")) {
    insights.push({
      id: "codex-10080",
      label: "Codex 每周",
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      forecast: { status: "unknown", exhaustionAt: null },
      pending: true,
    });
  }
  insights.sort((a, b) => {
    const order = { "cursor-models": 0, "cursor-api": 1, cursor: 1, "codex-300": 2, "codex-10080": 3 };
    return (order[a.id] ?? 10) - (order[b.id] ?? 10);
  });
  return insights;
}

function alertLevel(remainingPercent, warningThreshold = 20) {
  const remaining = clampPercent(remainingPercent);
  const warning = Math.min(90, Math.max(1, finite(warningThreshold) ?? 20));
  if (remaining == null || remaining > warning) return null;
  return remaining <= Math.min(10, warning / 2) ? "critical" : "warning";
}

module.exports = {
  alertLevel,
  buildQuotaInsights,
  codexWindows,
  forecastQuota,
};
