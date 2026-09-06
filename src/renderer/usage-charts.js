(function (root) {
  const numeric = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  function uniformRemaining(cycle, at) {
    const start = numeric(cycle?.reference?.startAt);
    const end = numeric(cycle?.reference?.endAt);
    const time = numeric(at);
    if (start == null || end == null || time == null || end <= start) return null;
    return Math.min(100, Math.max(0, 100 * (end - time) / (end - start)));
  }
  function uniformSegment(cycle, minAt, maxAt) {
    if (uniformRemaining(cycle, minAt) == null || maxAt < minAt) return [];
    const start = Math.max(minAt, cycle.reference.startAt);
    const end = Math.min(maxAt, cycle.reference.endAt);
    if (end < start) return [];
    return [{ at: start, remainingPercent: uniformRemaining(cycle, start) },
      { at: end, remainingPercent: uniformRemaining(cycle, end) }];
  }
  const fields = ["total", "effective", "count", "costCents", "input", "output", "cacheRead", "cacheWrite", "reasoning"];
  function modelSlices(sources, { source = "all", precision = "coarse", metric = "total" } = {}) {
    const groups = new Map();
    for (const origin of source === "all" ? ["cursor", "codex"] : [source]) {
      for (const row of sources?.[origin]?.modelBreakdowns?.[precision] || []) {
        const name = row.name || row.label || "未知模型";
        const unknown = row.fastKnown === false;
        const speed = unknown && origin !== "codex" ? "unknown" : !unknown && row.fast ? "fast" : "normal";
        const effort = row.effort || "默认";
        const key = JSON.stringify([name, precision === "coarse" ? null : speed, precision === "exact" ? effort : null]);
        if (!groups.has(key)) {
          const speedLabel = speed === "fast" ? "Fast" : speed === "unknown" ? "速度未知" : "非 Fast";
          groups.set(key, { key, name, label: [name, ...(precision === "exact" ? [effort] : []), ...(precision !== "coarse" ? [speedLabel] : [])].join(" · "),
            unknownCount: 0, ...Object.fromEntries(fields.map((field) => [field, 0])) });
        }
        const group = groups.get(key);
        for (const field of fields) group[field] += Math.max(0, numeric(row[field]) || 0);
        if (origin === "codex" && unknown) group.unknownCount += Math.max(0, numeric(row.count) || 0);
      }
    }
    const rows = [...groups.values()].sort((a, b) => b[metric] - a[metric] || a.label.localeCompare(b.label));
    const total = rows.reduce((sum, row) => sum + row[metric], 0);
    let offset = 0;
    return { total, rows: rows.map((row) => {
      const percent = total > 0 ? row[metric] / total * 100 : 0;
      const result = { ...row, value: row[metric], percent, offset };
      offset += percent;
      return result;
    }) };
  }
  const api = { uniformRemaining, uniformSegment, modelSlices };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UsageCharts = api;
})(typeof window === "object" ? window : this);
