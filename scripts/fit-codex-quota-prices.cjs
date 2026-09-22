#!/usr/bin/env node
// Read-only exploration of effective Codex quota prices in one weekly cycle.
// A fitted "dollar" is an API-price equivalent, never a subscription charge.
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { builtInSnapshot } = require('../src/pricing.cjs');
const FALLBACK_MODELS = builtInSnapshot().models;
// Credits in the official Codex rate card have the same ratios as these
// API-equivalent USD rates (Sol is 100/10/500 credits vs $4/$0.4/$20).
FALLBACK_MODELS['gpt-5.4-mini'] = { standard: { short: {
  input: .75, cacheRead: .075, cacheWrite: .9375, output: 4.52 } } };
FALLBACK_MODELS['gpt-5.4'] = { standard: { short: {
  input: 2.5, cacheRead: .25, cacheWrite: 3.125, output: 15 } } };

function argumentsOf(argv) {
  const options = { database: path.join(process.env.APPDATA || os.homedir(), 'cursor-usage-widget', 'usage-history.sqlite'),
    reset: null, until: null, anchor: null, anchorCapacity: null,
    minPoints: 2, top: 12, json: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { options.help = true; continue; }
    if (key === '--json') { options.json = true; continue; }
    if (!['--database', '--reset', '--until', '--anchor', '--anchor-capacity', '--min-points', '--top'].includes(key) || !argv[i + 1]) {
      throw new Error(`Unknown or incomplete option: ${key}`);
    }
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  for (const key of ['minPoints', 'top']) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (options.until) {
    options.until = Date.parse(options.until);
    if (!Number.isFinite(options.until)) throw new Error('--until must be an ISO date/time (include a timezone)');
  }
  if (options.anchorCapacity != null) {
    options.anchorCapacity = Number(options.anchorCapacity);
    if (!Number.isFinite(options.anchorCapacity) || options.anchorCapacity <= 0) {
      throw new Error('--anchor-capacity must be a positive API-equivalent dollar amount');
    }
  }
  return options;
}

function rateCost(row, model) {
  const rate = FALLBACK_MODELS[model]?.standard?.short;
  if (!rate) return null;
  const input = Math.max(0, row.input_tokens - row.cache_read_tokens - row.cache_write_tokens);
  return (input * rate.input + row.cache_read_tokens * rate.cacheRead
    + row.cache_write_tokens * rate.cacheWrite + row.output_tokens * rate.output) / 1e6;
}

function observedRows(db, options) {
  const cycles = db.prepare(`SELECT plan_type plan, resets_at reset, count(*) samples,
    max(used_percent)-min(used_percent) movement FROM codex_quota_observations
    WHERE quality='valid' AND window_minutes=10080 AND resets_at IS NOT NULL
    GROUP BY plan_type, resets_at HAVING movement>=? ORDER BY reset DESC`).all(options.minPoints);
  const chosen = options.reset
    ? cycles.find(c => String(c.reset) === String(options.reset) || new Date(c.reset).toISOString().startsWith(options.reset))
    : cycles[0];
  if (!chosen) throw new Error('No matching weekly cycle with enough valid quota movement');
  const start = chosen.reset - 10080 * 60_000;
  const end = Math.min(chosen.reset, options.until || Date.now());
  const rawSamples = db.prepare(`SELECT timestamp,used_percent percent FROM codex_quota_observations
    WHERE quality='valid' AND window_minutes=10080 AND plan_type=?
      AND resets_at BETWEEN ? AND ? AND timestamp BETWEEN ? AND ?
    ORDER BY timestamp`).all(chosen.plan, chosen.reset - 60_000, chosen.reset + 60_000, start, end);
  // Keep the first observation of each upward integer crossing. Duplicate
  // observations would otherwise let idle periods dominate a least-squares fit.
  const samples = [];
  let maxPercent = -Infinity;
  for (const s of rawSamples) {
    if (s.percent > maxPercent) { samples.push(s); maxPercent = s.percent; }
  }
  if (samples.length < 3 || samples.at(-1).percent - samples[0].percent < options.minPoints) {
    throw new Error('Selected interval has too few distinct percentage crossings');
  }
  const events = db.prepare(`SELECT event_key,timestamp,model,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,quota_equivalent_cost_cents,fast
    FROM usage_events WHERE source='codex' AND timestamp BETWEEN ? AND ?
      AND lower(model) NOT LIKE '%spark%' ORDER BY timestamp`).all(start, samples.at(-1).timestamp);
  const models = [...new Set(events.map(e => e.model))].filter(m => m !== 'codex-auto-review').sort();
  const unknown = events.filter(e => e.model !== 'codex-auto-review'
    && (!Number.isFinite(e.quota_equivalent_cost_cents) || e.quota_equivalent_cost_cents < 0));
  if (unknown.length) throw new Error(`${unknown.length} non-review events have no usable stored price`);
  return { cycle: chosen, start, end, samples, events, models };
}

function makePoints(data, reviewModel = 'gpt-5.6-sol') {
  const names = [...data.models, 'codex-auto-review'];
  const total = Object.fromEntries(names.map(n => [n, 0]));
  const points = [];
  let at = 0;
  for (const sample of data.samples) {
    while (at < data.events.length && data.events[at].timestamp <= sample.timestamp) {
      const e = data.events[at++];
      total[e.model] += e.model === 'codex-auto-review'
        ? rateCost(e, typeof reviewModel === 'function' ? reviewModel(e) : reviewModel)
        : e.quota_equivalent_cost_cents / 100;
    }
    points.push({ timestamp: sample.timestamp, percent: sample.percent,
      dollars: names.map(n => total[n]) });
  }
  return { names, points };
}

function leastSquares(points, rates) {
  let xy = 0, xx = 0;
  for (const point of points) {
    const x = point.dollars.reduce((s, d, j) => s + d * rates[j], 0);
    xy += x * point.percent; xx += x * x;
  }
  const slope = xx ? Math.max(0, xy / xx) : 0;
  return score(points, rates.map(v => v * slope), 100 / slope);
}

function score(points, coefficients, capacity = null) {
  let squared = 0, roundedSquared = 0, largest = 0;
  const predictions = points.map(point => {
    const predicted = point.dollars.reduce((s, d, j) => s + d * coefficients[j], 0);
    const error = predicted - point.percent;
    // Unknown integer rounding: the reported point permits a +/-1 envelope.
    const outside = Math.max(0, Math.abs(error) - 1);
    squared += error * error; roundedSquared += outside * outside;
    largest = Math.max(largest, Math.abs(error));
    return { timestamp: point.timestamp, observed: point.percent,
      predicted: Number(predicted.toFixed(3)), error: Number(error.toFixed(3)) };
  });
  return { capacity, coefficients, rmse: Math.sqrt(squared / points.length),
    roundingRmse: Math.sqrt(roundedSquared / points.length), maxError: largest,
    predictions };
}

function continuousFit(points, fixed = null) {
  // Small nonnegative least-squares problem, solved by coordinate descent.
  // No positive regularizer: zero/unstable coefficients are evidence of weak
  // identifiability, not a reason to manufacture a positive model weight.
  const width = points[0].dollars.length;
  const coefficients = Array(width).fill(0);
  if (fixed) coefficients[fixed.index] = 100 / fixed.capacity;
  const residual = points.map(p => p.percent);
  if (fixed) for (let i = 0; i < points.length; i++) {
    residual[i] -= points[i].dollars[fixed.index] * coefficients[fixed.index];
  }
  for (let pass = 0; pass < 3000; pass++) {
    let change = 0;
    for (let j = 0; j < width; j++) {
      if (j === fixed?.index) continue;
      let numerator = 0, denominator = 0;
      for (let i = 0; i < points.length; i++) {
        const x = points[i].dollars[j];
        numerator += x * (residual[i] + x * coefficients[j]);
        denominator += x * x;
      }
      const next = denominator ? Math.max(0, numerator / denominator) : 0;
      const delta = next - coefficients[j];
      if (delta) for (let i = 0; i < points.length; i++) residual[i] -= points[i].dollars[j] * delta;
      change = Math.max(change, Math.abs(delta));
      coefficients[j] = next;
    }
    if (change < 1e-11) break;
  }
  return score(points, coefficients);
}

function rankedGrid(data, anchor, top, anchorCapacity = null) {
  const models = data.models;
  const anchorIndex = models.indexOf(anchor);
  if (anchorIndex < 0) throw new Error(`Anchor ${anchor} has no events in this cycle`);
  const multipliers = [0, .25, .5, .75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];
  const reviews = [null, 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5.6-terra',
    'gpt-5.4', 'gpt-5.6-sol', 'gpt-6-astra'];
  const candidates = [];
  const ranks = Array(models.length).fill(1);
  function visit(index, points, review) {
    if (index === models.length) {
      const rates = [...ranks, review ? 1 : 0];
      const result = anchorCapacity == null ? leastSquares(points, rates)
        : score(points, rates.map(v => v * 100 / anchorCapacity), anchorCapacity);
      candidates.push({ review: review || 'free', multiplier: Object.fromEntries(models.map((m, j) => [m, ranks[j]])),
        capacity: result.capacity, rmse: result.rmse, roundingRmse: result.roundingRmse,
        maxError: result.maxError });
      return;
    }
    if (index === anchorIndex) return visit(index + 1, points, review);
    for (const value of multipliers) { ranks[index] = value; visit(index + 1, points, review); }
  }
  for (const review of reviews) visit(0, makePoints(data, review || 'gpt-5.6-sol').points, review);
  candidates.sort((a, b) => a.roundingRmse - b.roundingRmse || a.rmse - b.rmse);
  const bestByReview = Object.fromEntries(reviews.map(r => {
    const name = r || 'free';
    return [name, candidates.find(c => c.review === name)];
  }));
  return { tried: candidates.length,
    roundingCompatible: candidates.filter(c => c.roundingRmse < 1e-9).length,
    within005RmseOfBest: candidates.filter(c => c.rmse <= candidates[0].rmse + .05).length,
    bestByReview, top: candidates.slice(0, top) };
}

function run(options) {
  const db = new DatabaseSync(options.database, { readOnly: true });
  let data;
  try { data = observedRows(db, options); } finally { db.close(); }
  const { names, points } = makePoints(data);
  const anchor = options.anchor || (data.models.includes('gpt-5.6-sol') ? 'gpt-5.6-sol'
    : data.models.includes('gpt-6-astra') ? 'gpt-6-astra' : data.models[0]);
  const fit = continuousFit(points, options.anchorCapacity == null ? null
    : { index: names.indexOf(anchor), capacity: options.anchorCapacity });
  const anchorRate = fit.coefficients[names.indexOf(anchor)];
  return { basis: 'stored API-equivalent prices for named models; Sol rates for review in continuous fit',
    caveat: 'Only within-cycle relative prices are identifiable. Review model/rate is not identifiable if its multiplier is free. Integer percent and unlogged work create uncertainty.',
    cycle: { plan: data.cycle.plan, reset: new Date(data.cycle.reset).toISOString(),
      start: new Date(data.start).toISOString(), through: new Date(data.samples.at(-1).timestamp).toISOString(),
      observations: points.length, movement: points.at(-1).percent - points[0].percent,
      events: data.events.length, byModel: Object.fromEntries(names.map(n => [n, data.events.filter(e => e.model === n).length])) },
    anchor, anchorCapacity: options.anchorCapacity,
    continuous: { rmse: fit.rmse, roundingRmse: fit.roundingRmse, maxError: fit.maxError,
      effectiveCapacityDollars: Object.fromEntries(names.map((n, j) => [n,
        fit.coefficients[j] > 0 ? 100 / fit.coefficients[j] : null])),
      relativePriceMultiplier: Object.fromEntries(names.map((n, j) => [n,
        anchorRate > 0 ? fit.coefficients[j] / anchorRate : null])),
      predictions: fit.predictions },
    grid: rankedGrid(data, anchor, options.top, options.anchorCapacity) };
}

if (require.main === module) {
  try {
    const options = argumentsOf(process.argv.slice(2));
    if (options.help) {
      console.log('node scripts/fit-codex-quota-prices.cjs [--database FILE] [--reset ISO-OR-EPOCH] [--until ISO-WITH-TIMEZONE] [--anchor MODEL] [--anchor-capacity USD] [--min-points N] [--top N] [--json]');
    } else {
      const result = run(options);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        const { predictions, ...continuous } = result.continuous;
        console.log(JSON.stringify({ ...result, continuous }, null, 2));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { argumentsOf, rateCost, observedRows, makePoints,
  leastSquares, score, continuousFit, rankedGrid, run };
