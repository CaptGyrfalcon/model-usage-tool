(function exposeCodexMonthly(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexMonthly = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
const WEEK_MS = 7 * 86_400_000;
const RESET_TOLERANCE_MS = 60_000;
const number = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const percent = (value) => Math.max(0, Math.min(100, number(value) || 0));

function monthBounds(now = Date.now()) {
  const date = new Date(now);
  return {
    startAt: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
    endAt: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
  };
}

// Use a snapshot only from inside the requested interval, then add subsequent
// recorded costs. A snapshot after the cutoff cannot reveal pre-cutoff usage.
function historicalConsumption(samples, events, start, end, cycleEnd, capacity) {
  const sample = samples.filter((item) => item.source === "codex" && Number(item.windowMinutes) === 10080
    && Math.abs(Number(item.resetsAt) - cycleEnd) <= RESET_TOLERANCE_MS && item.timestamp >= start && item.timestamp < end
    && number(item.usedPercent) != null).sort((a, b) => b.timestamp - a.timestamp)[0];
  const recorded = events.filter((item) => item.source === "codex" && item.timestamp >= start && item.timestamp < end);
  const afterSample = recorded.filter((item) => !sample || item.timestamp > sample.timestamp);
  const priced = afterSample.filter((item) => number(item.quotaEquivalentCostCents) != null);
  const cost = priced.reduce((sum, item) => sum + Math.max(0, number(item.quotaEquivalentCostCents)), 0);
  const unpricedCount = afterSample.length - priced.length;
  const knownUsedCents = Math.min(capacity, (sample ? capacity * percent(sample.usedPercent) / 100 : 0) + cost);
  const complete = knownUsedCents >= capacity || ((sample || recorded.length > 0) && unpricedCount === 0);
  return { knownUsedCents, usedCents: complete ? knownUsedCents : null, unpricedCount,
    unknownReason: complete ? null : unpricedCount ? "unpriced-events" : "no-history",
    evidence: complete ? sample ? "sample-and-records" : "records" : "missing" };
}

// A changed reset date starts a new allowance, including early plan changes and
// manual resets. Small second-level differences are server timestamp jitter.
function observedCycles(samples, weekly, now, monthStart, monthEnd) {
  const groups = [];
  const rows = samples.filter((s) => s.source === "codex" && Number(s.windowMinutes) === 10080
    && number(s.resetsAt) != null && number(s.usedPercent) != null && s.timestamp <= now
    && s.resetsAt > s.timestamp && s.resetsAt - WEEK_MS <= s.timestamp + RESET_TOLERANCE_MS)
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const row of [...rows, { ...weekly, timestamp: now, live: true }]) {
    let group = groups.find((g) => Math.abs(g.resetAt - row.resetsAt) <= RESET_TOLERANCE_MS
      && (!g.planType || !row.planType || g.planType === row.planType));
    if (!group) {
      group = { resetAt: row.resetsAt, startAt: row.resetsAt - WEEK_MS, planType: row.planType || null };
      groups.push(group);
    }
    group.planType ||= row.planType || null;
    group.resetAt = row.resetsAt;
    group.startAt = row.resetsAt - WEEK_MS;
    if (row.live) group.current = true;
  }
  groups.sort((a, b) => a.startAt - b.startAt);
  const active = groups.findIndex((g) => g.current);
  if (active >= 0) groups.splice(active + 1);
  const result = [];
  let first = groups[0].startAt;
  while (first > monthStart) first -= WEEK_MS;
  for (let start = first; start < groups[0].startAt; start += WEEK_MS) {
    result.push({ startAt: start, endAt: start + WEEK_MS, resetAt: start + WEEK_MS });
  }
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i], next = groups[i + 1];
    const endAt = Math.min(group.resetAt, next?.startAt ?? Infinity);
    if (endAt > group.startAt) result.push({ ...group, endAt, interrupted: endAt < group.resetAt - RESET_TOLERANCE_MS });
    // Preserve unobserved natural cycles without shifting earlier observed ones.
    for (let start = group.resetAt; next && start < next.startAt; start += WEEK_MS) {
      result.push({ startAt: start, endAt: Math.min(start + WEEK_MS, next.startAt), resetAt: start + WEEK_MS });
    }
  }
  for (let start = weekly.resetsAt; start < monthEnd; start += WEEK_MS) {
    result.push({ startAt: start, endAt: start + WEEK_MS, resetAt: start + WEEK_MS, planType: weekly.planType });
  }
  return result.filter((g) => g.endAt > monthStart && g.startAt < monthEnd);
}

function capacityFromCycle(samples, events, cycle) {
  const sample = samples.filter((s) => s.source === "codex" && Number(s.windowMinutes) === 10080
    && Math.abs(s.resetsAt - cycle.resetAt) <= RESET_TOLERANCE_MS
    && s.timestamp >= cycle.startAt && s.timestamp < cycle.endAt && percent(s.usedPercent) > 0)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!sample) return null;
  const cost = events.filter((e) => e.source === "codex" && e.timestamp >= cycle.startAt && e.timestamp <= sample.timestamp)
    .reduce((sum, e) => sum + Math.max(0, number(e.quotaEquivalentCostCents) || 0), 0);
  // Dollar equivalents remain estimates; never borrow a new plan's capacity
  // to value the old plan's percentages.
  return cost > 0 ? cost / (percent(sample.usedPercent) / 100) : null;
}

// Calendar-month planning estimate: full intersecting weeks, less consumption
// already spent before this month in the first overlapping week.
function buildCodexMonthly({ windows = [], shortLimit = "unknown", samples = [], events = [], now = Date.now() } = {}) {
  const weekly = windows.find((item) => Number(item.windowMinutes) === 10080);
  const short = shortLimit === "absent" ? null : windows.find((item) => Number(item.windowMinutes) === 300);
  const shortLimitState = shortLimit === "absent" ? "absent" : short ? "present" : "unknown";
  let weeklyCapacity = number(weekly?.quotaEstimate?.inferredTotalCents);
  const reset = number(weekly?.resetsAt);
  if (!reset || reset <= now || reset - WEEK_MS > now || weekly.expired) return null;
  const { startAt, endAt } = monthBounds(now);
  const currentStart = reset - WEEK_MS;
  const observed = observedCycles(samples, weekly, now, startAt, endAt);
  if (!(weeklyCapacity > 0) && weekly.planType) {
    const previous = observed.filter((c) => c.endAt <= currentStart && c.planType === weekly.planType).reverse();
    weeklyCapacity = previous.map((c) => capacityFromCycle(samples, events, c)).find((value) => value > 0);
  }
  if (!(weeklyCapacity > 0)) return null;
  const weeklyUsed = number(weekly.usedPercent) ?? (number(weekly.percentRemaining) == null ? null : 100 - number(weekly.percentRemaining));
  if (weeklyUsed == null) return null;
  const cycles = [];
  for (const observedCycle of observed) {
    const { startAt: start, endAt: end, resetAt, planType, interrupted = false } = observedCycle;
    let usedCents = null;
    let knownUsedCents = 0;
    let unknownReason = null;
    let unpricedCount = 0;
    let evidence = "missing";
    const state = end <= now ? "completed" : start <= now ? "current" : "future";
    const capacity = state === "completed" && planType
      ? capacityFromCycle(samples, events, observedCycle) : weeklyCapacity;
    // An old plan with no usable price evidence has no defensible dollar total.
    if (!(capacity > 0)) return null;
    if (state === "current") { usedCents = weeklyCapacity * percent(weeklyUsed) / 100; evidence = "live"; }
    if (state === "future") { usedCents = 0; evidence = "projected"; }
    if (state === "completed") {
      ({ usedCents, knownUsedCents, unpricedCount, unknownReason, evidence } = historicalConsumption(samples, events, start, end, resetAt, capacity));
    }
    knownUsedCents = usedCents ?? knownUsedCents;
    const previous = start < startAt ? historicalConsumption(samples, events, start, startAt, resetAt, capacity) : null;
    // Remove the same amount from capacity and usage. Remaining water and
    // expired/unknown balances are unchanged, so prior-month use is not charged twice.
    const previousMonthUsedCents = Math.min(previous?.knownUsedCents || 0, knownUsedCents);
    cycles.push({ startAt: start, endAt: end, resetAt, planType, interrupted, state, evidence,
      grossCapacityCents: capacity, capacityCents: capacity - previousMonthUsedCents,
      usedCents: usedCents == null ? null : usedCents - previousMonthUsedCents,
      knownUsedCents: knownUsedCents - previousMonthUsedCents,
      previousMonthUsedCents,
      previousMonthUsageKnown: !previous || (previous.usedCents != null && previousMonthUsedCents === previous.knownUsedCents),
      unknownReason, unpricedCount, unknownCents: usedCents == null ? Math.max(0, capacity - knownUsedCents) : 0,
      unusedCents: usedCents == null ? null : Math.max(0, capacity - usedCents) });
  }
  const completed = cycles.filter((cycle) => cycle.state === "completed");
  const future = cycles.filter((cycle) => cycle.state === "future");
  const weeklyRemainingCents = weeklyCapacity * (100 - percent(weeklyUsed)) / 100;
  const shortCapacityCents = number(short?.quotaEstimate?.inferredTotalCents);
  const shortRemaining = number(short?.percentRemaining) ?? (number(short?.usedPercent) == null ? null : 100 - number(short.usedPercent));
  const immediateCents = shortLimitState === "absent" ? weeklyRemainingCents : shortCapacityCents > 0 && shortRemaining != null && !short.expired
    ? Math.min(weeklyRemainingCents, shortCapacityCents * percent(shortRemaining) / 100) : 0;
  const immediateKnown = shortLimitState === "absent" || weeklyRemainingCents === 0 || (shortCapacityCents > 0 && shortRemaining != null && !short.expired);
  const futureCents = future.length * weeklyCapacity;
  const expiredUnusedCents = completed.reduce((sum, cycle) => sum + (cycle.unusedCents || 0), 0);
  const unknownCents = completed.reduce((sum, cycle) => sum + cycle.unknownCents, 0);
  return {
    startAt, endAt, currentStart, currentEnd: reset, cycleCount: cycles.length,
    futureResetCount: future.length, completedCount: completed.length,
    capacityCents: cycles.reduce((sum, cycle) => sum + cycle.capacityCents, 0), weeklyCapacityCents: weeklyCapacity,
    grossCapacityCents: cycles.reduce((sum, cycle) => sum + cycle.grossCapacityCents, 0),
    previousMonthUsedCents: cycles.reduce((sum, cycle) => sum + cycle.previousMonthUsedCents, 0),
    previousMonthUsageKnown: cycles.every((cycle) => cycle.previousMonthUsageKnown),
    shortLimit: shortLimitState, shortCapacityCents, immediateCents, immediateKnown, weeklyRemainingCents, futureCents,
    lockedCents: futureCents + weeklyRemainingCents - immediateCents,
    expiredUnusedCents, unknownCents,
    usedCents: cycles.reduce((sum, cycle) => sum + cycle.knownUsedCents, 0),
    remainingCents: futureCents + weeklyRemainingCents,
    estimated: true, cycles,
  };
}

return { buildCodexMonthly, monthBounds, WEEK_MS };
});
