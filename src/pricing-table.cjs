function rateOf(tier) {
  if (!tier) return null;
  const rate = tier.short || tier;
  if (rate?.input == null && rate?.output == null) return null;
  return {
    input: Number(rate.input) || 0,
    cacheRead: Number(rate.cacheRead) || 0,
    cacheWrite: Number(rate.cacheWrite) || 0,
    output: Number(rate.output) || 0,
  };
}

function longRateOf(tier) {
  if (!tier?.long || !tier?.short) return null;
  const short = rateOf(tier.short);
  const long = rateOf(tier.long);
  if (!short || !long) return null;
  if (short.input === long.input && short.cacheRead === long.cacheRead && short.cacheWrite === long.cacheWrite && short.output === long.output) {
    return null;
  }
  return long;
}

function flattenPricingSnapshot(snapshot, { source = "all" } = {}) {
  const catalogs = [];
  const bySource = snapshot?.modelsBySource || {};
  if (source === "all" || source === "cursor") catalogs.push(["cursor", bySource.cursor || (source === "cursor" ? snapshot?.models : null) || {}]);
  if (source === "all" || source === "codex") catalogs.push(["codex", bySource.codex || {}]);
  if (!catalogs.length && snapshot?.models) catalogs.push(["cursor", snapshot.models]);

  const rows = [];
  for (const [catalog, models] of catalogs) {
    for (const [name, model] of Object.entries(models || {})) {
      for (const speed of ["standard", "fast"]) {
        const tier = model?.[speed];
        const rate = rateOf(tier);
        if (!rate) continue;
        const long = longRateOf(tier);
        rows.push({
          source: catalog,
          model: name,
          speed,
          speedLabel: speed === "fast" ? "Fast" : "非 Fast",
          context: "default",
          contextLabel: long ? "默认上下文" : "全部上下文",
          ...rate,
        });
        if (long) {
          rows.push({
            source: catalog,
            model: name,
            speed,
            speedLabel: speed === "fast" ? "Fast" : "非 Fast",
            context: "long",
            contextLabel: "长上下文",
            ...long,
          });
        }
      }
    }
  }
  return rows.sort((a, b) => (
    a.source.localeCompare(b.source)
    || a.model.localeCompare(b.model)
    || (a.speed === b.speed ? 0 : a.speed === "standard" ? -1 : 1)
    || (a.context === b.context ? 0 : a.context === "default" ? -1 : 1)
  ));
}

function summarizePricingSnapshot(snapshot) {
  const rows = flattenPricingSnapshot(snapshot);
  return {
    id: snapshot?.id ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    status: snapshot?.status || "unknown",
    note: snapshot?.note || "",
    sourceUrls: snapshot?.sourceUrls || [],
    modelCount: new Set(rows.map((row) => `${row.source}:${row.model}`)).size,
    rowCount: rows.length,
  };
}

module.exports = {
  flattenPricingSnapshot,
  summarizePricingSnapshot,
};
