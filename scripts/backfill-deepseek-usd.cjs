const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {UsageHistory,HISTORY_DB_PATH}=require('../src/history.cjs');
const {resolveCredential}=require('../src/deepseek.cjs');
const {buildDeepSeekArchive,historyCacheKey}=require('../src/deepseek-history.cjs');
const {addHistoricalUsdPricing,billingUsdPricing}=require('../src/deepseek-usd.cjs');
const {buildModelUsage,getTrendUsage}=require('../src/lib.cjs');
const {getReceipt}=require('../src/receipt.cjs');
const directory=path.resolve(__dirname,'../work/deepseek-history');
const read=file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
const backup=JSON.parse(fs.readFileSync(path.join(directory,'../deepseek-usd-backup.json'),'utf8'));
const digest=value=>createHash('sha256').update(value).digest('hex');
assert.equal(digest(fs.readFileSync(backup.backup)),backup.sha256,'backup changed');
const check=new DatabaseSync(backup.backup,{readOnly:true});
try{assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{check.close();}
const credential=resolveCredential();
assert.equal(credential?.kind,'account');
const accountKey=digest(`${credential.kind}:${credential.secret}`);
const apply=process.argv.includes('--apply');
const rehearsal=path.join(directory,`usd-rehearsal-${Date.now()}.sqlite`);
if(!apply)fs.copyFileSync(backup.backup,rehearsal);
async function main(){
  const history=new UsageHistory(apply?HISTORY_DB_PATH:rehearsal);
  try{
    assert.equal(history.loadCache('deepseek-active-account')?.value.accountKey,accountKey);
    const metadata=history.loadCache(historyCacheKey(accountKey))?.value;
    assert.ok(metadata);
    const windows=read('windows.json');
    const archive=buildDeepSeekArchive({accountKey,amountWindows:windows.windows.map(w=>read(w.amount.file).data),
      costWindows:windows.windows.map(w=>read(w.cost.file).data),walletCosts:read('wallet-costs.json'),
      invoices:read('probe-invoices.json').data.invoices,summary:read('probe-summary.json').data,
      start:metadata.start,end:metadata.queriedEnd,closedBefore:metadata.end,tz:windows.tz});
    let result;
    if(apply){
      const staged=read('usd-staged.json');
      assert.equal(staged.accountKey,accountKey);assert.equal(staged.backupSha256,backup.sha256);
      result={events:staged.events,errors:[]};
      assert.equal(result.events.length,archive.events.length);
      const original=new Map(archive.events.map(e=>[e.eventKey,e]));
      for(const event of result.events){
        const expected=original.get(event.eventKey);assert.ok(expected);
        for(const key of ['input','output','cacheRead','count','billingAmount','billingCurrency','billingDate'])assert.equal(event[key],expected[key]);
        assert.equal(event.equivalentCostCents,billingUsdPricing(event)?.equivalentCostCents,'staged FX invalid');
      }
    }else{
      result=await addHistoricalUsdPricing(history,archive.events);
      assert.deepEqual(result.errors,[]);
      fs.writeFileSync(path.join(directory,'usd-staged.json'),JSON.stringify({accountKey,backupSha256:backup.sha256,events:result.events},null,2));
    }
    assert.ok(result.events.every(e=>e.equivalentCostCents!=null),'some bills remain unpriced');
    const hashRows=query=>digest(JSON.stringify(history.db.prepare(query).all()));
    history.db.exec('BEGIN IMMEDIATE');
    try{
      const beforeOthers=hashRows("SELECT * FROM usage_events WHERE source != 'deepseek' ORDER BY source,event_key");
      const beforeBalances=hashRows('SELECT * FROM balance_samples ORDER BY source,account_key,currency,timestamp');
      const beforeMetadata=JSON.stringify(metadata);
      for(const event of result.events){
        const existing=history.getEvents({sources:'deepseek',start:event.timestamp,end:event.timestamp+1}).find(e=>e.eventKey===event.eventKey);
        assert.ok(existing,'historical row missing');
        for(const key of ['input','output','cacheRead','count'])assert.equal(existing[key],event[key],'Token or count changed');
      }
      history.upsertEvents(result.events,{transaction:false});
      assert.equal(hashRows("SELECT * FROM usage_events WHERE source != 'deepseek' ORDER BY source,event_key"),beforeOthers);
      assert.equal(hashRows('SELECT * FROM balance_samples ORDER BY source,account_key,currency,timestamp'),beforeBalances);
      assert.equal(JSON.stringify(history.loadCache(historyCacheKey(accountKey))?.value),beforeMetadata);
      history.db.exec('COMMIT');
    }catch(error){history.db.exec('ROLLBACK');throw error;}
    assert.equal(history.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const events=history.getEvents({sources:'deepseek',start:metadata.start,end:metadata.end});
    const models=buildModelUsage(events,'all').sources.deepseek;
    assert.equal(models.eventCount,345);assert.equal(models.costCoveragePercent,100);
    const receipt=getReceipt(history,{source:'deepseek',date:'2026-10-03'});
    assert.equal(receipt.rows[0].count,105);assert.equal(receipt.rows[0].unpriced,0);
    const report={applied:apply,backup:backup.backup,integrity:'ok',unrelatedUsageUnchanged:true,balancesUnchanged:true,
      rows:events.length,requests:models.eventCount,tokens:events.reduce((n,e)=>n+e.input+e.output+e.cacheRead,0),
      nativeCny:events.reduce((n,e)=>n+Number(e.billingAmount),0),usd:events.reduce((n,e)=>n+e.equivalentCostCents/100,0),
      harnessUsd:receipt.rows[0].costCents/100,costCoveragePercent:models.costCoveragePercent,
      quotes:events.map(e=>({consumptionDate:e.billingDate,publishedDate:e.fxDate,usdPerCny:e.fxRate,nativeAmount:e.billingAmount,usd:e.equivalentCostCents/100}))};
    fs.writeFileSync(path.join(directory,apply?'usd-import-result.json':'usd-rehearsal-result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }finally{history.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
