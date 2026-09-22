#!/usr/bin/env node
// Read-only historical backtest of fixed Codex quota-price hypotheses.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { rateCost } = require('./fit-codex-quota-prices.cjs');
const { sessionFiles, parentTimelines } = require('./fit-codex-parent-review.cjs');

const SCENARIOS = [
  { name: 'parent-shared', multiplier: { 'gpt-6-astra': 1.34, 'gpt-5.6-luna': 8.38 } },
  { name: 'review-sol', multiplier: { 'gpt-6-astra': 1.5, 'gpt-5.6-luna': 6 } },
];
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const date = timestamp => new Date(timestamp).toISOString();

function weeklyCycles(db) {
  const rows = db.prepare(`SELECT timestamp,used_percent percent,resets_at reset,plan_type plan
    FROM codex_quota_observations WHERE quality='valid' AND window_minutes=10080
      AND plan_type IN ('prolite','plus') AND resets_at IS NOT NULL
      AND used_percent BETWEEN 0 AND 100 ORDER BY timestamp`).all();
  const groups = [];
  for (const row of rows) {
    let group = groups.find(g => g.plan === row.plan && Math.abs(g.reset - row.reset) <= 60_000);
    if (!group) { group = { plan: row.plan, reset: row.reset, samples: [] }; groups.push(group); }
    group.samples.push(row);
  }
  const cycles = groups.map(g => {
    g.samples.sort((a, b) => a.timestamp - b.timestamp);
    const unique = [];
    let highest = -Infinity;
    for (const sample of g.samples) {
      if (sample.percent > highest) { unique.push(sample); highest = sample.percent; }
    }
    g.samples = unique;
    return g;
  }).sort((a, b) => a.samples[0].timestamp - b.samples[0].timestamp);
  // Old reset identities can keep arriving after a new reset has appeared.
  // Treat the first observation for the new identity as the handoff point.
  for (let i = 0; i < cycles.length; i++) {
    const next = cycles.slice(i + 1).find(g => g.plan === cycles[i].plan && g.reset > cycles[i].reset + 60_000);
    if (next) cycles[i].samples = cycles[i].samples.filter(s => s.timestamp < next.samples[0].timestamp);
  }
  return cycles.filter(g => g.samples.length >= 3 && g.samples.at(-1).percent - g.samples[0].percent >= 3);
}

function imageCalls(files) {
  const calls = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.includes('image_gen__imagegen')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response_item' && record.payload?.type === 'custom_tool_call'
        && String(record.payload.input || '').includes('tools.image_gen__imagegen')) {
        calls.push(Date.parse(record.timestamp));
      }
    }
  }
  return calls.sort((a, b) => a - b);
}

function sessionModel(event, sessions, useParent = false) {
  let id = /^codex:v2:([0-9a-f-]{36}):/.exec(event.event_key || '')?.[1];
  if (useParent) id = sessions.get(id)?.parent;
  const visited = new Set();
  while (id && !visited.has(id)) {
    visited.add(id);
    const session = sessions.get(id);
    let selected = null;
    for (const state of session?.models || []) {
      if (state.timestamp > event.timestamp) break;
      if (state.model !== 'codex-auto-review') selected = state.model;
    }
    if (selected) return selected;
    id = session?.parent;
  }
  return null;
}

function pricedEvent(event, scenario, sessions) {
  if (event.model === 'codex-auto-review') {
    const model = scenario.name === 'review-sol' ? 'gpt-5.6-sol' : sessionModel(event, sessions, true);
    const base = rateCost(event, model);
    return base == null ? { cost: null, model } : {
      cost: base * (scenario.name === 'review-sol' ? 1 : scenario.multiplier[model] || 1), model };
  }
  const base = event.quota_equivalent_cost_cents;
  const model = event.model === 'unknown' ? sessionModel(event, sessions) : event.model;
  if (Number.isFinite(base) && base >= 0) {
    return { cost: base / 100 * (scenario.multiplier[model] || 1), model };
  }
  // A zero-token usage delta has zero non-fast cost even if its model is missing.
  if (!(event.input_tokens || event.output_tokens || event.cache_read_tokens || event.cache_write_tokens)) {
    return { cost: 0, model };
  }
  const standardCost = rateCost(event, model);
  return { cost: standardCost == null ? null : standardCost * (scenario.multiplier[model] || 1), model };
}

function evaluate(samples, events, scenario, capacity, sessions) {
  const first = samples[0];
  let index = 0, cost = 0;
  const unknown = [];
  let maxError = 0, sumSquared = 0, failures = 0, overFailures = 0, underFailures = 0;
  let fitNumerator = 0, fitDenominator = 0, firstFailure = null;
  const predictions = [];
  for (const sample of samples.slice(1)) {
    while (index < events.length && events[index].timestamp <= sample.timestamp) {
      const event = events[index++];
      const priced = pricedEvent(event, scenario, sessions);
      if (priced.cost == null) unknown.push({ model: priced.model, eventKey: event.event_key });
      else cost += priced.cost;
    }
    const predicted = cost * 100 / capacity;
    const observed = sample.percent - first.percent;
    // Two integer observations create a conservative +/-2 point envelope.
    // At 100%, the reported meter is saturated; only an underprediction can fail.
    const error = sample.percent === 100 ? Math.min(0, predicted - (98 - first.percent))
      : predicted - observed;
    const outside = Math.max(0, Math.abs(error) - 2);
    sumSquared += error * error;
    maxError = Math.max(maxError, Math.abs(error));
    if (sample.percent < 100) {
      fitNumerator += cost * observed;
      fitDenominator += cost * cost;
    }
    if (outside > 1e-9) {
      failures++;
      if (error > 0) overFailures++; else underFailures++;
      if (!firstFailure) firstFailure = { at: date(sample.timestamp), observed: sample.percent,
        predicted: first.percent + predicted, error };
    }
    predictions.push({ at: date(sample.timestamp), observed: sample.percent,
      predicted: first.percent + predicted, error });
  }
  return { status: unknown.length ? 'unpriced' : failures ? 'mismatch' : 'compatible',
    unknownCount: unknown.length, unknownModels: [...new Set(unknown.map(x => x.model))],
    failures, overFailures, underFailures, maxError,
    impliedCapacity: fitNumerator > 0 ? 100 * fitDenominator / fitNumerator : null,
    rmse: Math.sqrt(sumSquared / Math.max(1, predictions.length)),
    firstFailure, lastPrediction: predictions.at(-1), events: events.length };
}

function audit(database, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const cycles = weeklyCycles(db);
    const files = sessionFiles(home, cycles[0].samples[0].timestamp,
      cycles.at(-1).samples.at(-1).timestamp);
    const sessions = parentTimelines(files);
    const images = imageCalls(files);
    const reports = [];
    for (const cycle of cycles) {
      const first = cycle.samples[0];
      const firstImage = images.find(t => t > first.timestamp && t <= cycle.samples.at(-1).timestamp);
      const samples = firstImage == null ? cycle.samples : cycle.samples.filter(s => s.timestamp < firstImage);
      const last = samples.at(-1);
      if (samples.length < 3 || last.percent - first.percent < 3) {
        reports.push({ plan: cycle.plan, reset: date(cycle.reset), first: date(first.timestamp),
          firstImage: firstImage == null ? null : date(firstImage), status: 'insufficient-preimage-samples',
          observations: samples.length });
        continue;
      }
      const events = db.prepare(`SELECT event_key,timestamp,model,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,quota_equivalent_cost_cents
        FROM usage_events WHERE source='codex' AND timestamp>? AND timestamp<=?
          AND lower(model) NOT LIKE '%spark%' ORDER BY timestamp`).all(first.timestamp, last.timestamp);
      const capacity = cycle.plan === 'plus' ? 96 : 480;
      reports.push({ plan: cycle.plan, capacity, reset: date(cycle.reset),
        first: date(first.timestamp), last: date(last.timestamp),
        firstImage: firstImage == null ? null : date(firstImage),
        firstPercent: first.percent, lastPercent: last.percent,
        observations: samples.length, events: events.length,
        reviews: events.filter(e => e.model === 'codex-auto-review').length,
        imageCalls: images.filter(t => t > first.timestamp && t <= last.timestamp).length,
        models: [...new Set(events.map(e => e.model))],
        scenarios: Object.fromEntries(SCENARIOS.map(s => [s.name,
          evaluate(samples, events, s, capacity, sessions)])) });
    }
    return reports;
  } finally { db.close(); }
}

if (require.main === module) {
  const databaseIndex = process.argv.indexOf('--database');
  const database = databaseIndex >= 0 ? process.argv[databaseIndex + 1]
    : path.join(process.env.APPDATA || os.homedir(), 'cursor-usage-widget', 'usage-history.sqlite');
  const reports = audit(database);
  for (const plan of ['prolite', 'plus']) {
    console.log(JSON.stringify({ plan, cycles: reports.filter(r => r.plan === plan) }, null, 2));
  }
}

module.exports = { weeklyCycles, imageCalls, sessionModel, pricedEvent, evaluate, audit };
