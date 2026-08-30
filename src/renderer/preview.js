if (!window.widget && new URLSearchParams(location.search).has("preview")) {
  const now = Date.now();
  const makeSeries = (count, hourly) => Array.from({ length: count }, (_unused, index) => {
    const input = (index % 5 + 1) * 180_000;
    const cacheWrite = index % 3 === 0 ? (index % 2 + 1) * 90_000 : 0;
    const cacheRead = (index % 4 + 1) * 420_000;
    const output = (index % 3 + 1) * 75_000;
    const inputCostCents = input / 1_000_000 * 400;
    const cacheWriteCostCents = cacheWrite / 1_000_000 * 500;
    const cacheReadCostCents = cacheRead / 1_000_000 * 40;
    const outputCostCents = output / 1_000_000 * 2_000;
    const slice = (ratio) => ({
      input: input * ratio,
      output: output * ratio,
      cacheRead: cacheRead * ratio,
      cacheWrite: cacheWrite * ratio,
      effective: (input + output) * ratio,
      total: (input + output + cacheWrite + cacheRead) * ratio,
      inputCostCents: inputCostCents * ratio,
      cacheWriteCostCents: cacheWriteCostCents * ratio,
      cacheReadCostCents: cacheReadCostCents * ratio,
      cacheCostCents: (cacheWriteCostCents + cacheReadCostCents) * ratio,
      outputCostCents: outputCostCents * ratio,
      equivalentCostCents: (inputCostCents + cacheWriteCostCents + cacheReadCostCents + outputCostCents) * ratio,
    });
    const fastRatio = 0.22 + (index % 5) * 0.07;
    const normalRatio = Math.max(0, 1 - fastRatio);
    return {
      start: now - (count - index) * (hourly ? 3_600_000 : 86_400_000),
      label: hourly ? `${String(index).padStart(2, "0")}:00–${String(index + 1).padStart(2, "0")}:00` : `8月${index + 1}日`,
      shortLabel: hourly ? String(index).padStart(2, "0") : `8/${index + 1}`,
      input, output, cacheRead, cacheWrite,
      effective: input + output,
      total: input + output + cacheWrite + cacheRead,
      inputCostCents,
      cacheWriteCostCents,
      cacheReadCostCents,
      cacheCostCents: cacheWriteCostCents + cacheReadCostCents,
      outputCostCents,
      equivalentCostCents: inputCostCents + cacheWriteCostCents + cacheReadCostCents + outputCostCents,
      count: index % 4 + 1,
      speed: {
        normal: slice(normalRatio),
        fast: slice(fastRatio),
      },
    };
  });
  const trends = { day: makeSeries(24, true), week: makeSeries(7, false), month: makeSeries(30, false) };
  const modelRows = [
    { label: "gpt-5.6-sol · Fast", name: "gpt-5.6-sol", fast: true, fastKnown: true, count: 42, input: 11_800_000, cacheRead: 36_800_000, cacheWrite: 0, output: 2_400_000, reasoning: 740_000, effective: 14_200_000, total: 51_000_000, costCents: 8_430 },
    { label: "grok-4.6 · 标准", name: "grok-4.6", fast: false, fastKnown: true, count: 35, input: 7_700_000, cacheRead: 23_900_000, cacheWrite: 0, output: 1_400_000, reasoning: 310_000, effective: 9_100_000, total: 33_000_000, costCents: 2_150 },
    { label: "gpt-5.6-terra · 速度未知", name: "gpt-5.6-terra", fast: false, fastKnown: false, count: 18, input: 4_050_000, cacheRead: 12_200_000, cacheWrite: 0, output: 750_000, reasoning: 180_000, effective: 4_800_000, total: 17_000_000, costCents: 990 },
  ];
  const source = (label) => ({ label, periodLabel: "最近 30 天", eventCount: 95, costAvailable: true, costCoveragePercent: 93.4, modelBreakdowns: { coarse: modelRows, speed: modelRows, exact: modelRows }, trends });
  const modelRangeLabels = { all: "全部历史", months6: "近 6 个月", months3: "近 3 个月", month1: "近 1 个月", days14: "近 14 天", days7: "近 7 天", day1: "近 1 天", hours12: "近 12 小时", hours6: "近 6 小时", hour1: "近 1 小时" };
  const previewModelUsage = (key) => ({
    key,
    label: modelRangeLabels[key] || modelRangeLabels.month1,
    sources: {
      all: { ...source("全部"), periodLabel: modelRangeLabels[key] || modelRangeLabels.month1 },
      cursor: { ...source("Cursor"), periodLabel: modelRangeLabels[key] || modelRangeLabels.month1 },
      codex: { ...source("Codex"), periodLabel: modelRangeLabels[key] || modelRangeLabels.month1 },
    },
  });
  const data = {
    fetchedAt: now,
    billingCycleStart: now - 11 * 86_400_000,
    billingCycleEnd: now + 19 * 86_400_000,
    email: "preview@example.com",
    planName: "Pro",
    cursorModels: { name: "Cursor 模型", hint: "Grok / Composer", percentUsed: 61.37, percentRemaining: 38.63, speedUsage: { normal: 4_600, fast: 3_000, unknown: 0, total: 7_600, basis: "equivalent-cost" }, tokens: { effective: 22_000_000, total: 68_000_000 }, apiEquivalent: { equivalentCostCents: 7_600, inputCostCents: 2_000, cacheWriteCostCents: 1_500, cacheReadCostCents: 600, outputCostCents: 3_500 }, quotaEstimate: { usedCents: 7_600, inferredTotalCents: 12_459 } },
    otherModels: { name: "其他模型", hint: "Claude / GPT 等", percentUsed: 91.24, percentRemaining: 8.76, speedUsage: { normal: 2_080, fast: 2_900, unknown: 200, total: 5_180, basis: "equivalent-cost" }, includedCents: { used: 1_820, limit: 2_000, remaining: 180 }, tokens: { effective: 11_000_000, total: 36_000_000 }, apiEquivalent: { equivalentCostCents: 5_180, inputCostCents: 1_500, cacheWriteCostCents: 900, cacheReadCostCents: 280, outputCostCents: 2_500 }, quotaEstimate: { usedCents: 5_180, inferredTotalCents: 5_692, packageTotalCents: 2_000 } },
    onDemand: { enabled: false },
    costs: { cycleEquivalent: { equivalentCostCents: 12_780, coveragePercent: 100 } },
    codex: {
      planName: "Plus", files: 89, periodLabel: "5 小时额度", eventCount: 64,
      quota: {
        primary: { slot: "primary", name: "5 小时额度", windowMinutes: 300, usedPercent: 64, percentRemaining: 36, resetsAt: now + 2 * 3_600_000, speedUsage: { normal: 1_500, fast: 1_275, unknown: 200, total: 2_975, basis: "equivalent-cost" }, quotaEstimate: { usedCents: 2_975, inferredTotalCents: 4_648 } },
        secondary: { slot: "secondary", name: "7 天额度", windowMinutes: 10_080, usedPercent: 27, percentRemaining: 73, resetsAt: now + 4 * 86_400_000, speedUsage: { normal: 5_000, fast: 3_100, unknown: 400, total: 8_500, basis: "equivalent-cost" }, quotaEstimate: { usedCents: 8_500, inferredTotalCents: 31_481 } },
      },
      tokens: { period: { effective: 18_500_000, total: 61_500_000 } },
      apiEquivalent: { equivalentCostCents: 2_975, equivalentCostLowCents: 2_975, equivalentCostHighCents: 4_900, inputCostCents: 700, cacheWriteCostCents: 450, cacheReadCostCents: 225, outputCostCents: 1_600, inferredTotalCents: 4_648, inferredTotalLowCents: 4_648, inferredTotalHighCents: 7_656, coveragePercent: 93.4 },
      quotaEquivalent: { equivalentCostCents: 2_975, equivalentCostLowCents: 2_975, equivalentCostHighCents: 4_900, inferredTotalCents: 4_648, inferredTotalLowCents: 4_648, inferredTotalHighCents: 7_656 },
      tierEvidence: { response: 38, local: 21, unknown: 5 },
    },
    combined: { tokens: { today: { effective: 8_700_000, total: 29_400_000 }, h1: { effective: 1_420_000, total: 5_160_000 } }, eventCount: 95, lastEvent: { source: "codex", model: "gpt-5.6-sol", effort: "high", at: now - 90_000, equivalentCostCents: 86, tokens: { input: 120_000, output: 24_000, cacheRead: 410_000, cacheWrite: 0 } } },
    persistence: { count: 6_148, earliest: now - 45 * 86_400_000 },
    sources: { all: source("全部"), cursor: source("Cursor"), codex: source("Codex") },
    sourceStatus: { cursor: { ok: true }, codex: { ok: true } },
    pricing: { fetchedAt: now, status: "remote", note: "已从官方文档更新" },
    modelUsage: previewModelUsage("month1"),
  };
  data.codex.quota.windows = [data.codex.quota.primary, data.codex.quota.secondary];
  data.quotaInsights = [
    { id: "cursor-models", label: "Cursor 模型池", usedPercent: 91.24, remainingPercent: 8.76, resetsAt: data.billingCycleEnd, forecast: { status: "exhaust", exhaustionAt: now + 26 * 3_600_000 } },
    { id: "cursor-api", label: "Cursor API 池", usedPercent: 34.5, remainingPercent: 65.5, resetsAt: data.billingCycleEnd, forecast: { status: "safe", exhaustionAt: now + 35 * 86_400_000 } },
    { id: "codex-300", label: "Codex 5 小时", usedPercent: 64, remainingPercent: 36, resetsAt: data.codex.quota.primary.resetsAt, forecast: { status: "exhaust", exhaustionAt: now + 70 * 60_000 } },
    { id: "codex-10080", label: "Codex 每周", usedPercent: 27, remainingPercent: 73, resetsAt: data.codex.quota.secondary.resetsAt, forecast: { status: "safe", exhaustionAt: now + 11 * 86_400_000 } },
  ];
  const previewQuery = new URLSearchParams(location.search);
  const previewSettings = { opacity: 0.96, compact: false, orbMode: previewQuery.get("orb") === "1", orbPool: previewQuery.get("orbPool") || "cursor-models", orbDisplayMode: previewQuery.get("orbDisplay") || "quota", intervalMs: 30_000, activeTab: previewQuery.get("tab") || "models", modelRange: "month1", modelPrecision: "speed", trendRange: "day", trendMetric: "total", trendBreakdown: true, trendSpeedBreakdown: previewQuery.get("speed") === "1", dataSource: "all", tokenDisplayVersion: 2, smartDock: false, privacyMode: previewQuery.get("privacy") === "1", quotaAlerts: true, alertThreshold: 20 };
  const previewWindowState = { fullscreen: new URLSearchParams(location.search).get("fullscreen") === "1" };
  const listeners = { snapshot: [], settings: [], windowState: [] };
  window.widget = {
    getSnapshot: async () => ({ ok: true, loading: false, data }),
    refresh: async () => null,
    refreshPricing: async () => null,
    getSettings: async () => previewSettings,
    getWindowState: async () => previewWindowState,
    getModelUsage: async (range) => previewModelUsage(range),
    toggleFullscreen: async (force) => {
      previewWindowState.fullscreen = typeof force === "boolean" ? force : !previewWindowState.fullscreen;
      listeners.windowState.forEach((callback) => callback(previewWindowState));
      return previewWindowState;
    },
    saveSettings: async (partial) => { Object.assign(previewSettings, partial); listeners.settings.forEach((callback) => callback(previewSettings)); },
    setPointerPresence: async () => null,
    setOpacity: async () => null,
    hide: async () => null,
    openDashboard: async () => null,
    quit: async () => null,
    onSnapshot: (callback) => { listeners.snapshot.push(callback); return () => {}; },
    onSettings: (callback) => { listeners.settings.push(callback); return () => {}; },
    onWindowState: (callback) => { listeners.windowState.push(callback); return () => {}; },
    onWindowMotion: () => () => {},
  };
}
