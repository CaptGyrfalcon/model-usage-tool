#!/usr/bin/env node
// Read-only fit: bill each auto-review request as its immediate parent's model.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { argumentsOf, observedRows, rateCost, continuousFit, score } = require('./fit-codex-quota-prices.cjs');

function sessionFiles(home, start, end) {
  const root = path.join(home, 'sessions');
  const files = [];
  // Rollout folders follow local time, while record timestamps are UTC.
  const earliest = new Date(start - 8 * 86400_000).toISOString().slice(0, 10);
  const latest = new Date(end + 86400_000).toISOString().slice(0, 10);
  for (const year of fs.readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory())) {
    const ydir = path.join(root, year.name);
    for (const month of fs.readdirSync(ydir, { withFileTypes: true }).filter(x => x.isDirectory())) {
      const mdir = path.join(ydir, month.name);
      for (const day of fs.readdirSync(mdir, { withFileTypes: true }).filter(x => x.isDirectory())) {
        const date = `${year.name}-${month.name}-${day.name}`;
        if (date < earliest || date > latest) continue;
        for (const file of fs.readdirSync(path.join(mdir, day.name))) {
          if (file.endsWith('.jsonl')) files.push(path.join(mdir, day.name, file));
        }
      }
    }
  }
  return files;
}

function parentTimelines(files) {
  const sessions = new Map();
  for (const file of files) {
    let id = null;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload || {};
      if (record.type === 'session_meta') {
        id = payload.id || payload.session_id;
        if (!id) continue;
        if (!sessions.has(id)) sessions.set(id, { parent: null, models: [] });
        if (payload.parent_thread_id) sessions.get(id).parent = payload.parent_thread_id;
      } else if (record.type === 'turn_context' && id && payload.model) {
        sessions.get(id).models.push({ timestamp: Date.parse(record.timestamp), model: payload.model });
      }
    }
  }
  for (const session of sessions.values()) session.models.sort((a, b) => a.timestamp - b.timestamp);
  return sessions;
}

function reviewParentModel(event, sessions) {
  const id = /^codex:v2:([0-9a-f-]{36}):/.exec(event.event_key || '')?.[1];
  const parentId = sessions.get(id)?.parent;
  const timeline = sessions.get(parentId)?.models || [];
  let selected = null;
  for (const state of timeline) {
    if (state.timestamp > event.timestamp) break;
    selected = state.model;
  }
  return selected;
}

function pointsByParent(data, sessions, { reviewSeparate = false } = {}) {
  const names = reviewSeparate ? [...data.models, 'codex-auto-review'] : data.models;
  const totals = Object.fromEntries(names.map(m => [m, 0]));
  const parentCounts = {};
  const unresolved = [];
  const pricedEvents = [];
  for (const event of data.events) {
    if (event.model !== 'codex-auto-review') { pricedEvents.push({ ...event, billedModel: event.model,
      billedDollars: event.quota_equivalent_cost_cents / 100 }); continue; }
    const parent = reviewParentModel(event, sessions);
    if (!parent || !names.includes(parent)) { unresolved.push({ timestamp: event.timestamp, eventKey: event.event_key, parent }); continue; }
    parentCounts[parent] = (parentCounts[parent] || 0) + 1;
    pricedEvents.push({ ...event, billedModel: reviewSeparate ? 'codex-auto-review' : parent,
      billedDollars: rateCost(event, parent) });
  }
  if (unresolved.length) return { names, parentCounts, unresolved, points: [] };
  const points = [];
  let index = 0;
  for (const sample of data.samples) {
    while (index < pricedEvents.length && pricedEvents[index].timestamp <= sample.timestamp) {
      const event = pricedEvents[index++];
      totals[event.billedModel] += event.billedDollars;
    }
    points.push({ timestamp: sample.timestamp, percent: sample.percent,
      dollars: names.map(n => totals[n]) });
  }
  return { names, parentCounts, unresolved, points };
}

function fit(options, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const db = new DatabaseSync(options.database, { readOnly: true });
  let data;
  try { data = observedRows(db, options); } finally { db.close(); }
  const sessions = parentTimelines(sessionFiles(home, data.start, data.samples.at(-1).timestamp));
  const { names, points, parentCounts, unresolved } = pointsByParent(data, sessions);
  if (unresolved.length) return { unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 20), parentCounts };
  const anchor = options.anchor || 'gpt-5.6-sol';
  const anchorIndex = names.indexOf(anchor);
  if (anchorIndex < 0) throw new Error(`Anchor ${anchor} has no events`);
  const best = continuousFit(points, options.anchorCapacity == null ? null
    : { index: anchorIndex, capacity: options.anchorCapacity });
  const base = best.coefficients[anchorIndex];
  const fixed = options.anchorCapacity == null ? null : score(points, best.coefficients, options.anchorCapacity);
  let fixedReviewOneX = null;
  if (options.anchorCapacity != null) {
    const separate = pointsByParent(data, sessions, { reviewSeparate: true });
    const adjusted = separate.points.map(p => ({ ...p,
      percent: p.percent - p.dollars.at(-1) * 100 / options.anchorCapacity,
      dollars: p.dollars.slice(0, -1) }));
    const fittedMain = continuousFit(adjusted, { index: anchorIndex, capacity: options.anchorCapacity });
    const checked = score(separate.points,
      [...fittedMain.coefficients, 100 / options.anchorCapacity], options.anchorCapacity);
    fixedReviewOneX = { rmse: checked.rmse, roundingRmse: checked.roundingRmse,
      maxError: checked.maxError, failures: checked.predictions.filter(p => Math.abs(p.error) > 1).length,
      multiplier: Object.fromEntries(data.models.map((name, i) => [name,
        fittedMain.coefficients[i] * options.anchorCapacity / 100])) };
  }
  return { cycle: { plan: data.cycle.plan, start: new Date(data.start).toISOString(),
    through: new Date(data.samples.at(-1).timestamp).toISOString(), observations: points.length,
    events: data.events.length, reviewEvents: data.events.filter(e => e.model === 'codex-auto-review').length },
    parentCounts, unresolvedCount: 0, anchor, anchorCapacity: options.anchorCapacity,
    fixedReviewOneX,
    fit: { rmse: best.rmse, roundingRmse: best.roundingRmse, maxError: best.maxError,
      multiplier: Object.fromEntries(names.map((name, i) => [name, base ? best.coefficients[i] / base : null])),
      modelCapacity: Object.fromEntries(names.map((name, i) => [name,
        best.coefficients[i] ? 100 / best.coefficients[i] : null])),
      failures: fixed ? fixed.predictions.filter(p => Math.abs(p.error) > 1).length : best.predictions.filter(p => Math.abs(p.error) > 1).length,
      predictions: best.predictions } };
}

if (require.main === module) {
  try {
    const options = argumentsOf(process.argv.slice(2));
    if (options.help) console.log('node scripts/fit-codex-parent-review.cjs [--until ISO-WITH-TIMEZONE] [--anchor-capacity USD] [--json]');
    else {
      const result = fit(options);
      if (!options.json && result.fit) delete result.fit.predictions;
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { sessionFiles, parentTimelines, reviewParentModel, pointsByParent, fit };
