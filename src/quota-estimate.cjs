// Bounds are conditional on complete local usage and aligned server observations.
// Unknown integer rounding uses the envelope of floor/nearest/ceil, not a
// statistical confidence interval. Never borrow capacity from another reset.
function estimateQuota({ samples = [], events = [], window, sampledAt, planType, rounding = "unknown" }) {
  const result = { inferredTotalCents: null, inferredTotalLowCents: null,
    inferredTotalHighCents: null, packageTotalSource: "cycle-sample-intersection",
    estimateStatus: "insufficient-data", sampleCount: 0, rounding };
  if (!window || window.expired || !Number.isFinite(window.resetsAt) || !window.windowMinutes) return result;
  const start = window.resetsAt - window.windowMinutes * 60_000;
  const rows = samples.filter(s => s.source === "codex" && s.windowMinutes === window.windowMinutes
    && (s.quality == null || s.quality === "valid")
    && Number.isFinite(s.resetsAt) && Math.abs(s.resetsAt - window.resetsAt) <= 60_000
    && s.timestamp >= start && s.timestamp <= sampledAt
    && (!planType || s.planType === planType)
    && s.usedPercent != null && Number.isFinite(s.usedPercent) && s.usedPercent >= 0 && s.usedPercent <= 100)
    .sort((a, b) => a.timestamp - b.timestamp);
  const usage = events.filter(e => e.source === "codex" && !/spark/i.test(e.model || "")
    && e.timestamp >= start && e.timestamp <= sampledAt).sort((a, b) => a.timestamp - b.timestamp);
  let lowCost = 0, highCost = 0, index = 0, low = 0, high = Infinity;
  for (const sample of rows) {
    while (index < usage.length && usage[index].timestamp <= sample.timestamp) {
      const e = usage[index++];
      const a = e.quotaEquivalentCostLowCents ?? e.quotaEquivalentCostCents;
      const b = e.quotaEquivalentCostHighCents ?? e.quotaEquivalentCostCents;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) {
        return { ...result, estimateStatus: "unpriced-events" };
      }
      lowCost += a; highCost += b;
    }
    const p = sample.usedPercent;
    const lowerP = Math.max(0, p - (rounding === "floor" ? 0 : rounding === "nearest" ? 0.5 : 1));
    const upperP = p === 100 ? Infinity : Math.min(100, p + (rounding === "ceil" ? 0 : rounding === "nearest" ? 0.5 : 1));
    low = Math.max(low, upperP > 0 ? 100 * lowCost / upperP : lowCost > 0 ? Infinity : 0);
    high = Math.min(high, lowerP > 0 ? 100 * highCost / lowerP : Infinity);
    result.sampleCount++;
  }
  if (!result.sampleCount) return result;
  if (low > high || high <= 0 || !Number.isFinite(low)) return { ...result, estimateStatus: "inconsistent" };
  return { ...result, inferredTotalLowCents: low,
    inferredTotalHighCents: Number.isFinite(high) ? high : null,
    inferredTotalCents: Number.isFinite(high) ? low + (high - low) / 2 : null,
    estimateStatus: Number.isFinite(high) ? "bounded" : "unbounded" };
}

module.exports = { estimateQuota };
