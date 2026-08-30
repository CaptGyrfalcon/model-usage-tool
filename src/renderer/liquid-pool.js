(function exposeLiquidPool(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LiquidPool = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));

  function capacityOf(pool) {
    const candidates = [
      pool?.capacityCents,
      pool?.quotaEstimate?.packageTotalCents,
      pool?.quotaEstimate?.inferredTotalCents,
      pool?.includedCents?.limit,
    ];
    const value = candidates.map(Number).find((candidate) => Number.isFinite(candidate) && candidate > 0);
    return value || null;
  }

  function codexPool(windows, fallbackCapacity = null) {
    const listed = (Array.isArray(windows) ? windows : [])
      .filter(Boolean)
      .slice()
      .sort((a, b) => (Number(a.windowMinutes) || Infinity) - (Number(b.windowMinutes) || Infinity));
    if (!listed.length) return null;
    const short = listed[0];
    const long = listed[listed.length - 1];
    const shortRemaining = clamp(short.percentRemaining ?? (100 - Number(short.usedPercent)));
    const weeklyRemaining = clamp(long.percentRemaining ?? (100 - Number(long.usedPercent)));
    const weeklyCapacityCents = capacityOf(long) || Number(fallbackCapacity) || null;
    const shortCapacityCents = capacityOf(short);
    // Both colors share the weekly tank. Scale the 5-hour remaining percent by
    // the actual inferred capacity ratio, not a fixed quarter of the week.
    const share = shortCapacityCents && weeklyCapacityCents
      ? Math.min(1, shortCapacityCents / weeklyCapacityCents)
      : listed.length === 1 && weeklyCapacityCents ? 1 : null;
    const immediateRemaining = share == null
      ? (listed.length === 1 ? shortRemaining : 0)
      : Math.min(shortRemaining * share, weeklyRemaining);
    const weeklyOnlyRemaining = Math.max(0, weeklyRemaining - immediateRemaining);
    return {
      id: "codex-combined",
      source: "codex",
      name: listed.length > 1 ? "Codex 联合池" : `Codex · ${short.name || "额度池"}`,
      used: 100 - weeklyRemaining,
      remaining: immediateRemaining,
      weeklyRemaining,
      weeklyOnlyRemaining,
      shortRemaining,
      capacityCents: weeklyCapacityCents,
      shortCapacityCents,
      usedCents: Number(long?.quotaEstimate?.usedCents) || null,
      capacityEstimated: true,
      precision: 2,
      detail: listed.length > 1
        ? `5 小时可用 ${shortRemaining.toFixed(2)}% · 仅周池可用 ${weeklyOnlyRemaining.toFixed(2)}%`
        : `当前可用 ${shortRemaining.toFixed(2)}%`,
    };
  }

  function sizeScales(pools) {
    const capacities = pools.map(capacityOf).filter(Boolean);
    const maximum = capacities.length ? Math.max(...capacities) : null;
    return pools.map((pool) => {
      const capacity = capacityOf(pool);
      if (!maximum || !capacity) return 1;
      // Tanks are treated as spheres: volume follows diameter cubed.
      return Math.cbrt(capacity / maximum);
    });
  }

  function damageParts(cents) {
    const dollars = Math.max(0, Number(cents) || 0) / 100;
    const [integer, fraction] = dollars.toFixed(4).split(".");
    return { major: `-$${integer}.${fraction.slice(0, 2)}`, minor: fraction.slice(2) };
  }

  function remainingDrop(previous, pool, key) {
    return Math.max(0, (Number(previous?.[key]) || 0) - (Number(pool?.[key]) || 0));
  }

  const MIN_DRAIN_MS = 900;
  const MIN_SPEND_CENTS = 5;
  const MAX_SPEND_CENTS = 200;

  function refreshEffectDuration(amountCents, intervalMs = 30_000) {
    const minMs = MIN_DRAIN_MS;
    const cycleMs = Math.max(minMs, Number(intervalMs) || 30_000);
    const cents = Math.max(0, Number(amountCents) || 0);
    if (cents <= MIN_SPEND_CENTS) return minMs;
    if (cents >= MAX_SPEND_CENTS) return cycleMs;
    const progress = (cents - MIN_SPEND_CENTS) / (MAX_SPEND_CENTS - MIN_SPEND_CENTS);
    return Math.round(minMs + progress * (cycleMs - minMs));
  }

  function refreshSpend(previous, pool) {
    if (!previous || !pool) return null;
    const levelDelta = Math.max(remainingDrop(previous, pool, "remaining"), remainingDrop(previous, pool, "weeklyRemaining"));
    const previousUsed = Number(previous.usedCents);
    const nextUsed = Number(pool.usedCents);
    const exactDelta = Number.isFinite(previousUsed) && Number.isFinite(nextUsed)
      ? Math.max(0, nextUsed - previousUsed)
      : null;
    const estimatedDelta = levelDelta > 0 && Number(pool.capacityCents) > 0
      ? levelDelta * Number(pool.capacityCents) / 100
      : 0;
    const amountCents = exactDelta == null ? estimatedDelta : exactDelta;
    if (!(amountCents > 0)) return null;
    return { amountCents, levelDelta };
  }

  return { capacityOf, clamp, codexPool, damageParts, refreshEffectDuration, refreshSpend, sizeScales };
});
