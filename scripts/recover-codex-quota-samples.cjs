// Explicit-path recovery. Originals and old quota_samples are preserved.
// Always run on a copy first. --backup must be a verified pre-repair SQLite file.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CodexUsageScanner } = require('../src/codex.cjs');
const { UsageHistory } = require('../src/history.cjs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--database') || !process.argv.includes('--backup')) {
  throw new Error('Required: --database <target> --backup <pre-repair SQLite>');
}
const target = path.resolve(arg('--database')), backup = path.resolve(arg('--backup'));
if (target === backup || !fs.existsSync(target) || !fs.existsSync(backup)) throw new Error('Target and backup must exist and differ');
const check = new DatabaseSync(backup, { readOnly: true });
if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed');
check.close();
function eventDigest(db) {
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT * FROM usage_events ORDER BY source,event_key').iterate()) hash.update(JSON.stringify(row));
  return hash.digest('hex');
}
const before = new DatabaseSync(target, { readOnly: true });
const digest = eventDigest(before);
const oldCount = before.prepare('SELECT count(*) n FROM quota_samples').get().n;
before.close();
const scanner = new CodexUsageScanner(undefined, { fullHistory: true });
const scan = scanner.scan();
if (!scan.files || !scan.quotaSamples.length || scan.scanErrors.length) {
  throw new Error(`Recovery aborted: ${JSON.stringify({ files: scan.files, errors: scan.scanErrors })}`);
}
// Recovery only writes observation tables; skip unrelated startup backfills.
class RecoveryHistory extends UsageHistory {
  ensureUsageColumns() {}
  migrateCursorSnapshotEvents() {}
  unifyCodexDollarEquivalent() {}
  normalizeUnknownTierCosts() {}
  migrateLegacyHistory() {}
}
const history = new RecoveryHistory(target);
try {
  history.db.exec('BEGIN IMMEDIATE');
  for (const sample of scan.quotaSamples) history.saveQuotaSample(sample);
  history.saveCache('codex-provenance-samples-v1', { at: Date.now(), backup, recoveredFiles: scan.files });
  if (eventDigest(history.db) !== digest) throw new Error('Usage events changed unexpectedly');
  if (history.db.prepare('SELECT count(*) n FROM quota_samples').get().n !== oldCount) throw new Error('Legacy observations changed unexpectedly');
  history.db.exec('COMMIT');
  console.log(JSON.stringify({ target, backup, files: scan.files,
    integrity: history.db.prepare('PRAGMA integrity_check').get().integrity_check,
    usageEventsUnchanged: true, legacySamplesPreserved: oldCount,
    observations: history.db.prepare('SELECT origin,quality,count(*) n FROM codex_quota_observations GROUP BY origin,quality').all(),
    latest: scan.rateLimit?.windows,
  }, null, 2));
} catch (error) { try { history.db.exec('ROLLBACK'); } catch {} throw error; }
finally { history.close(); }
