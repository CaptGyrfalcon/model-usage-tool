const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { UsageHistory, HISTORY_DB_PATH } = require('../src/history.cjs');
const { resolveCredential } = require('../src/deepseek.cjs');
const { buildDeepSeekArchive, importDeepSeekArchive } = require('../src/deepseek-history.cjs');
const { buildBalanceTimeline } = require('../src/balance-timeline.cjs');
const { buildModelUsage } = require('../src/lib.cjs');
const root = path.resolve(__dirname, '../work');
const directory = path.join(root, 'deepseek-history');
const read = file => JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(root,'deepseek-history-backup.json'),'utf8'));
assert.equal(createHash('sha256').update(fs.readFileSync(backup.backup)).digest('hex'),backup.sha256,'database backup changed');
const backupDb = new DatabaseSync(backup.backup,{readOnly:true});
try { assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok'); }finally{backupDb.close();}
const credential=resolveCredential();
assert.equal(credential?.kind,'account','Harness account login required');
const accountKey=createHash('sha256').update(`${credential.kind}:${credential.secret}`).digest('hex');
const windows=read('windows.json');
const now=Date.now();
const localNow=new Date(now),closedBefore=+new Date(localNow.getFullYear(),localNow.getMonth(),localNow.getDate());
const archive=buildDeepSeekArchive({accountKey,
  amountWindows:windows.windows.map(window=>read(window.amount.file).data),
  costWindows:windows.windows.map(window=>read(window.cost.file).data),
  walletCosts:read('wallet-costs.json'),invoices:read('probe-invoices.json').data.invoices,summary:read('probe-summary.json').data,
  start:Date.parse(windows.windows[0].start),end:Date.parse(windows.windows.at(-1).end),closedBefore,tz:windows.tz,now});
const apply=process.argv.includes('--apply');
const rehearsalPath=path.join(directory,'history-rehearsal.sqlite');
if(!apply) {
  assert.ok(!fs.existsSync(rehearsalPath),'rehearsal already exists; use a new archive directory');
  fs.copyFileSync(backup.backup,rehearsalPath);
}
const history=new UsageHistory(apply?HISTORY_DB_PATH:rehearsalPath);
try {
  const active=history.loadCache('deepseek-active-account')?.value.accountKey;
  assert.equal(active,accountKey,'current account differs from archive account');
  assert.equal(history.getEvents({sources:'deepseek',start:archive.metadata.start,end:archive.metadata.end})
    .filter(event=>event.pool!=='deepseek-platform-daily').length,0,'local history overlaps; retain and reconcile it before importing');
  const otherRows=()=>history.db.prepare("SELECT * FROM usage_events WHERE source != 'deepseek' ORDER BY source,event_key").all();
  const beforeHash=createHash('sha256').update(JSON.stringify(otherRows())).digest('hex');
  const metadata=importDeepSeekArchive(history,archive);
  const afterHash=createHash('sha256').update(JSON.stringify(otherRows())).digest('hex');
  assert.equal(beforeHash,afterHash,'unrelated usage changed');
  assert.equal(history.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const events=history.getEvents({sources:'deepseek',start:metadata.start,end:metadata.end});
  const usage=buildModelUsage(events,'all',now).sources.deepseek;
  assert.equal(usage.eventCount,metadata.requests);
  const samples=history.getBalanceSamples({accountKey,currency:'CNY',end:now});
  const ranges=['day','week','month','year'].map(range=>{
    const timeline=buildBalanceTimeline(samples,{currency:'CNY',range,now});
    return {range,cycles:timeline.cycles.length,points:timeline.sampleCount,reconstructedPoints:timeline.reconstructedCount,
      latest:timeline.cycle.endRemaining};
  });
  const result={applied:apply,database:history.dbPath,backup:backup.backup,integrity:'ok',unrelatedUsageUnchanged:true,
    metadata,firstUsage:events.length?new Date(Math.min(...events.map(row=>row.timestamp))).toISOString():null,
    lastUsage:events.length?new Date(Math.max(...events.map(row=>row.timestamp))).toISOString():null,
    balancePoints:samples.length,ranges};
  fs.writeFileSync(path.join(directory,apply?'import-result.json':'rehearsal-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {history.close();}
