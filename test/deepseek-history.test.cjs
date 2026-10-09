const test = require('node:test');
const assert = require('node:assert/strict');
const { UsageHistory } = require('../src/history.cjs');
const { buildDeepSeekArchive, importDeepSeekArchive, uncoveredHarnessEvents, historyCacheKey } = require('../src/deepseek-history.cjs');
const { buildBalanceTimeline } = require('../src/balance-timeline.cjs');
const { buildModelUsage } = require('../src/lib.cjs');
const DAY=86400000, first=Date.parse('2026-08-02T00:00:00+08:00'), bonus=Date.parse('2026-10-03T00:00:00+08:00');
function fixture() {
  const rows=[{time:first/1000,cost:'3',usage:{PROMPT_CACHE_MISS_TOKEN:100,PROMPT_CACHE_HIT_TOKEN:200,RESPONSE_TOKEN:50,REQUEST:5}},
    {time:bonus/1000,cost:'1',usage:{PROMPT_CACHE_MISS_TOKEN:100,PROMPT_CACHE_HIT_TOKEN:300,RESPONSE_TOKEN:50,REQUEST:2}}];
  return {accountKey:'test-account',start:Date.parse('2025-10-05T00:00:00+08:00'),end:Date.parse('2026-10-06T00:00:00+08:00'),
    closedBefore:Date.parse('2026-10-05T00:00:00+08:00'),now:Date.parse('2026-10-05T12:00:00+08:00'),tz:28800,
    amountWindows:[{bucket:86400,series:[{api_key:{tracking_id:'private-key-id'},model:'deepseek-v4-pro',buckets:rows.map(({time,usage})=>({time,usage}))}]}],
    costWindows:[{bucket:86400,data:[{currency:'CNY',series:[{api_key:{tracking_id:'private-key-id'},model:'deepseek-v4-pro',buckets:rows.map(({time,cost})=>({time,cost}))}]}]}],
    walletCosts:rows.map((row,i)=>({start:new Date(row.time*1000).toISOString(),end:new Date(row.time*1000+DAY).toISOString(),model:'deepseek-v4-pro',
      walletType:i?'Granted':'Paid',cost:row.cost,currency:'CNY'})),
    invoices:{payment_orders:[{payment_order_status:'SUCCESS',paid_at:new Date(first+12*3600000).toISOString(),amount:'20',currency:'CNY'}],
      bonus_orders:[{bonus_order_status:'ACTIVE',inserted_at:new Date(bonus+12*3600000).toISOString(),amount:'6',currency:'CNY'}]},
    summary:{total_costs:[{currency:'CNY',amount:'4'}],normal_wallets:[{currency:'CNY',balance:'17'}],bonus_wallets:[{currency:'CNY',balance:'5'}]}};
}
test('official daily usage keeps actual request counts and reconstructs separate wallets only over complete closed days',()=>{
  const archive=buildDeepSeekArchive(fixture());
  assert.equal(archive.metadata.requests,7);
  assert.equal(archive.metadata.tokens,800);
  assert.equal(archive.events[0].billingAmount,'3');
  assert.equal(archive.events[0].billingCurrency,'CNY');
  assert.equal(archive.events[0].billingDate,'2026-08-02');
  assert.equal(buildModelUsage(archive.events,'all',fixture().now).sources.deepseek.eventCount,7);
  assert.equal(archive.samples[0].timestamp,first);
  assert.equal(archive.samples[0].total,0);
  assert.equal(archive.samples.find(sample=>sample.timestamp===first+DAY-1).total,17);
  assert.equal(archive.samples.find(sample=>sample.timestamp===bonus+DAY-1).total,22);
  assert.deepEqual([archive.samples.at(-1).toppedUp,archive.samples.at(-1).granted],[17,5]);
  assert.ok(archive.samples.every(sample=>sample.timestamp<fixture().closedBefore));
  assert.ok(!JSON.stringify(archive).includes('private-key-id'));
  const timeline=buildBalanceTimeline(archive.samples.map(row=>({...row,at:row.timestamp,balance:row.total})),{range:'year',now:fixture().now});
  assert.equal(timeline.reconstructedCount,archive.samples.length);
});
test('missing history, mismatched export, incomplete wallets and expired grants refuse historical balance reconstruction',()=>{
  let input=fixture(); input.summary.total_costs[0].amount='5';
  assert.throws(()=>buildDeepSeekArchive(input),/累计消费/);
  input=fixture(); input.walletCosts[0].cost='2';
  assert.throws(()=>buildDeepSeekArchive(input),/不一致/);
  input=fixture(); input.invoices.payment_orders=[];
  assert.throws(()=>buildDeepSeekArchive(input),/未对平/);
  input=fixture(); input.invoices.bonus_orders[0].bonus_order_status='EXPIRED';
  assert.throws(()=>buildDeepSeekArchive(input),/过期/);
});
test('history import is atomic, repeatable, account isolated and cannot overwrite an observed balance',()=>{
  const history=new UsageHistory(':memory:');
  try {
    const archive=buildDeepSeekArchive(fixture());
    const sample=archive.samples[1];
    history.saveBalanceSample({...sample,total:99,toppedUp:99,granted:0,origin:'observed'});
    const original=history.saveBalanceSample;
    history.saveBalanceSample=()=>{throw new Error('write interrupted');};
    assert.throws(()=>importDeepSeekArchive(history,archive),/interrupted/);
    assert.equal(history.getEvents({sources:'deepseek',end:fixture().now}).length,0);
    assert.equal(history.loadCache(historyCacheKey(archive.accountKey)),null);
    history.saveBalanceSample=original;
    importDeepSeekArchive(history,archive);
    importDeepSeekArchive(history,archive);
    assert.equal(history.getEvents({sources:'deepseek',end:fixture().now}).length,2);
    const samples=history.getBalanceSamples({accountKey:archive.accountKey,currency:'CNY',end:fixture().now});
    assert.equal(samples.length,archive.samples.length);
    assert.equal(samples.find(row=>row.at===sample.timestamp).balance,99);
    assert.equal(samples.find(row=>row.at===sample.timestamp).origin,'observed');
    assert.deepEqual(history.getBalanceSamples({accountKey:'other-account',currency:'CNY',end:fixture().now}),[]);
  }finally{history.close();}
});
test('covered account day totals suppress duplicate local requests and leave the current day to Harness logs',()=>{
  const {start,end}=buildDeepSeekArchive(fixture()).metadata;
  const events=[{timestamp:start-1},{timestamp:start},{timestamp:end-1},{timestamp:end}];
  assert.deepEqual(uncoveredHarnessEvents(events,{start,end}),[events[0],events[3]]);
  assert.deepEqual(uncoveredHarnessEvents(events,null),events);
});
