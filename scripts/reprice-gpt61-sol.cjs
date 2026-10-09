// Dry run by default. The accounting migration backs up SQLite before writing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { UsageHistory, HISTORY_DB_PATH } = require('../src/history.cjs');
const { priceEvent, modelKey, builtInSnapshot } = require('../src/pricing.cjs');
const { GPT61_VERSION } = require('../src/codex-accounting.cjs');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[at + 1];
}
const database = path.resolve(arg('--database', HISTORY_DB_PATH));
const report = arg('--report', null);
const apply = args.includes('--apply');
const costColumns = new Set(['input_cost_cents','cache_read_cost_cents','cache_write_cost_cents',
  'cache_cost_cents','output_cost_cents','equivalent_cost_cents','equivalent_cost_low_cents',
  'equivalent_cost_high_cents','quota_equivalent_cost_cents','quota_equivalent_cost_low_cents',
  'quota_equivalent_cost_high_cents','pricing_status']);
const target = row => row.source === 'codex' && modelKey(row.model) === 'gpt-6.1-sol';
const event = row => ({ source: row.source, eventKey: row.event_key, model: row.model,
  input: row.input_tokens, cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens,
  output: row.output_tokens, fast: row.fast === 1, fastKnown: row.fast != null });
const digest = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
function invariant(rows) {
  return digest(rows.map(row => target(row)
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !costColumns.has(key))) : row));
}
function summary(rows) {
  const out = {};
  for (const row of rows.filter(target)) {
    const mode = row.fast == null ? 'unknown_as_standard' : row.fast === 1 ? 'fast' : 'standard';
    const s = out[mode] ||= { rows: 0, unpriced: 0, usd: 0 };
    s.rows++; s.unpriced += row.equivalent_cost_cents == null ? 1 : 0;
    s.usd += (row.equivalent_cost_cents || 0) / 100;
  }
  return out;
}
let db = new DatabaseSync(database, { readOnly: true });
const before = db.prepare('SELECT * FROM usage_events ORDER BY source,event_key').all();
db.close();
const snapshot = builtInSnapshot();
const preview = before.filter(target).map(row => ({ ...row,
  equivalent_cost_cents: priceEvent(event(row), snapshot).equivalentCostCents }));
const result = { mode: apply ? 'applied' : 'dry-run', database, version: GPT61_VERSION,
  before: summary(before), predicted: summary(preview) };
if (apply) {
  // Use only the scoped accounting migration. Constructing UsageHistory also
  // runs unrelated startup/schema migrations, which this maintenance task avoids.
  const history = Object.create(UsageHistory.prototype);
  history.dbPath = database;
  history.db = new DatabaseSync(database);
  try {
    const migration = history.applyCodexAccounting(snapshot, {
      version: GPT61_VERSION, model: 'gpt-6.1-sol',
    });
    Object.assign(result, migration);
    const after = history.db.prepare('SELECT * FROM usage_events ORDER BY source,event_key').all();
    if (before.length !== after.length || invariant(before) !== invariant(after)) {
      throw new Error('History invariant failed: event count, raw metadata, or other model changed');
    }
    for (const row of after.filter(target)) {
      const expected = priceEvent(event(row), snapshot);
      if (Math.abs(row.equivalent_cost_cents - expected.equivalentCostCents) > 1e-8
        || row.equivalent_cost_cents == null
        || row.quota_equivalent_cost_cents !== row.equivalent_cost_cents) {
        throw new Error(`Price verification failed: ${row.event_key}`);
      }
    }
    result.after = summary(after);
    result.integrity = history.db.prepare('PRAGMA integrity_check').all();
    if (result.integrity.some(row => row.integrity_check !== 'ok')) throw new Error('Integrity check failed');
    result.rawAndOtherModelsPreserved = true;
    result.eventCount = after.length;
    if (migration.backupPath) {
      result.backupSha256 = crypto.createHash('sha256').update(fs.readFileSync(migration.backupPath)).digest('hex');
    }
  } finally { history.close(); }
}
if (report) fs.writeFileSync(path.resolve(report), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
