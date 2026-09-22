const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CodexUsageScanner, mergeRateLimitSnapshots } = require('../src/codex.cjs');
const { UsageHistory } = require('../src/history.cjs');
const base = Date.UTC(2026, 8, 15);
const record = (time, p, total = 100) => JSON.stringify({ timestamp: new Date(time).toISOString(),
  type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { limit_id: 'codex', plan_type: 'prolite', secondary: null,
      primary: { used_percent: p, window_minutes: 10080, resets_at: (base + 604800000) / 1000 } },
    info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: total, total_tokens: total } },
  } }) + '\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-provenance-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('quota-provenance-')); fs.rmSync(dir, { recursive: true, force: true }); });
  class FixtureHistory extends UsageHistory { migrateLegacyHistory() {} }
  const history = new FixtureHistory(':memory:');
  t.after(() => history.close());
  history.saveCache('codex-provenance-samples-v1', { at: base });
  return { dir, history };
}
test('different sessions at the same time coexist; rescans and archive moves are idempotent', t => {
  const { dir, history } = fixture(t);
  for (const id of ['a', 'b']) fs.writeFileSync(path.join(dir, 'sessions', id + '.jsonl'), record(base, 1));
  const ingest = scan => scan.quotaSamples.forEach(s => history.saveQuotaSample(s));
  ingest(new CodexUsageScanner(dir).scan());
  assert.equal(history.getQuotaSamples().length, 2);
  assert.equal(new Set(history.getQuotaSamples().map(s => s.sampleKey)).size, 2);
  fs.mkdirSync(path.join(dir, 'archived_sessions'));
  fs.renameSync(path.join(dir, 'sessions/a.jsonl'), path.join(dir, 'archived_sessions/a.jsonl'));
  ingest(new CodexUsageScanner(dir).scan());
  assert.equal(history.getQuotaSamples().length, 2);
  assert.match(history.getQuotaSamples().find(s => s.sessionId === 'a').originPath, /archived_sessions/);
});
test('incremental timestamp conflicts invalidate earlier samples, preserve all originals, and cannot become live quota', t => {
  const { dir, history } = fixture(t);
  const file = path.join(dir, 'sessions/a.jsonl');
  fs.writeFileSync(file, record(base, 0, 50) + record(base + 1000, 1, 100));
  const scanner = new CodexUsageScanner(dir);
  scanner.scan().quotaSamples.forEach(s => history.saveQuotaSample(s));
  assert.equal(history.getQuotaSamples().length, 2);
  fs.appendFileSync(file, record(base + 1000, 4, 400));
  const scan = scanner.scan();
  scan.quotaSamples.forEach(s => history.saveQuotaSample(s));
  assert.equal(scan.rateLimit.primary.usedPercent, 0);
  assert.equal(history.getQuotaSamples().length, 1);
  const raw = history.getQuotaSamples({ includeUnreliable: true });
  assert.equal(raw.length, 3);
  assert.equal(raw.filter(s => s.quality === 'conflicting-timestamp').length, 2);
  assert.deepEqual(raw.map(s => s.recordIndex).sort(), [1, 2, 3]);
  new CodexUsageScanner(dir).scan().quotaSamples.forEach(s => history.saveQuotaSample(s));
  assert.equal(history.getQuotaSamples({ includeUnreliable: true }).length, 3);
});
test('same percentage with differing usage at the same timestamp is also ambiguous', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'sessions/a.jsonl'), record(base, 1, 100) + record(base, 1, 200));
  const scan = new CodexUsageScanner(dir).scan();
  assert.ok(scan.quotaSamples.every(s => s.quality === 'conflicting-timestamp'));
  assert.equal(scan.rateLimit, null);
});
test('identical duplicate records are retained without falsely invalidating their timestamp', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'sessions/a.jsonl'), record(base, 1) + record(base, 1));
  const scan = new CodexUsageScanner(dir).scan();
  assert.equal(scan.quotaSamples.length, 2);
  assert.ok(scan.quotaSamples.every(s => s.quality === 'valid'));
});
test('HTTP responses within one second retain independent row identities', t => {
  const { dir, history } = fixture(t);
  const db = new DatabaseSync(path.join(dir, 'logs_2.sqlite'));
  db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)');
  for (const p of [1,2]) db.prepare('INSERT INTO logs(ts,target,feedback_log_body) VALUES (?,?,?)').run(base/1000,
    'codex_http_client::client', JSON.stringify({ 'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-used-percent': String(p), 'x-codex-primary-reset-at': String(base/1000+604800) }));
  db.close();
  new CodexUsageScanner(dir, { fullHistory: true }).scan().quotaSamples.forEach(s => history.saveQuotaSample(s));
  assert.equal(history.getQuotaSamples().length, 2);
  assert.deepEqual(history.getQuotaSamples().map(s => s.recordIndex).sort(), [1,2]);
});
test('merged windows retain their own original timestamp', () => {
  const merged = mergeRateLimitSnapshots([
    { timestamp: base + 1000, windows: [{ windowMinutes: 300, resetsAt: base + 18000000, usedPercent: 1 }] },
    { timestamp: base, windows: [{ windowMinutes: 10080, resetsAt: base + 604800000, usedPercent: 5 }] },
  ]);
  assert.deepEqual(merged.windows.map(w => w.sampledAt), [base+1000, base]);
});
test('legacy samples remain archived but cannot leak into qualified history', t => {
  const { history } = fixture(t);
  history.saveQuotaSample({ source:'codex', pool:'primary-10080',timestamp:base,usedPercent:99 });
  history.saveQuotaSample({ source:'cursor', pool:'cursor-models',timestamp:base,usedPercent:25 });
  assert.equal(history.getQuotaSamples({ source:'codex' }).length, 0);
  assert.equal(history.getQuotaSamples().length, 1);
  assert.equal(history.db.prepare('SELECT count(*) n FROM quota_samples').get().n, 2);
});
