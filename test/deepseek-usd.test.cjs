const test=require('node:test');
const assert=require('node:assert/strict');
const {UsageHistory}=require('../src/history.cjs');
const {fetchHistoricalUsdRate,addHistoricalUsdPricing,billingUsdPricing}=require('../src/deepseek-usd.cjs');
const {priceEvent}=require('../src/pricing.cjs');
const {buildModelUsage,getTrendUsage}=require('../src/lib.cjs');
const {getReceipt}=require('../src/receipt.cjs');
const {csvRow}=require('../src/event-export.cjs');
const {estimateNativeFee,updateNativeEstimate}=require('../src/deepseek-estimate.cjs');
const {parseSession}=require('../src/deepseek.cjs');
const timestamp=+new Date(2026,9,3);
const event=()=>({source:'deepseek',eventKey:'deepseek:platform-daily:example',timestamp,model:'deepseek-flash',
  pool:'deepseek-platform-daily',input:130371,cacheRead:11459712,cacheWrite:0,output:93710,count:105,
  billingCurrency:'CNY',billingAmount:'0.73440524',billingDate:'2026-10-03',pricingStatus:'unavailable',fastKnown:false});
const response=(date='2026-10-02',rate=0.14915)=>({ok:true,json:async()=>({date,base:'CNY',quote:'USD',rate})});
test('historical rates retain consumption and publication dates, cache exact observations, and reject stale or future quotes',async()=>{
  const h=new UsageHistory(':memory:');
  try{
    let requests=0;
    const fetchFn=async(url,options)=>{requests++;assert.match(url,/\/providers\/ecb\/rate\/cny\/usd\?date=2026-10-03$/);
      assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{Accept:'application/json'});return response();};
    const rate=await fetchHistoricalUsdRate(h,'2026-10-03',{fetchFn});
    assert.equal(rate.date,'2026-10-02');assert.equal(rate.requestedDate,'2026-10-03');
    assert.deepEqual(await fetchHistoricalUsdRate(h,'2026-10-03',{fetchFn}),rate);assert.equal(requests,1);
    await assert.rejects(fetchHistoricalUsdRate(h,'2026-10-04',{fetchFn:async()=>response('2026-10-05')}),/无效/);
    await assert.rejects(fetchHistoricalUsdRate(h,'2026-10-04',{fetchFn:async()=>response('2026-09-01')}),/无效/);
    await assert.rejects(fetchHistoricalUsdRate(h,'2026-02-30',{fetchFn}),/日期无效/);
  }finally{h.close();}
});
test('official CNY bills convert to USD through model statistics, trends, receipts and exports without changing Token or request totals',async()=>{
  const h=new UsageHistory(':memory:');
  try{
    const result=await addHistoricalUsdPricing(h,[event()],{fetchFn:async()=>response()});
    assert.deepEqual(result.errors,[]);
    const priced=result.events[0],expected=0.73440524*0.14915*100;
    assert.equal(priced.equivalentCostCents,expected);assert.equal(priced.quotaEquivalentCostCents,null);
    assert.equal(priceEvent(priced,null).equivalentCostCents,expected);
    h.upsertEvents(result.events);
    const stored=h.getEvents({sources:'deepseek',end:timestamp+1})[0];
    assert.equal(stored.billingAmount,'0.73440524');assert.equal(stored.fxDate,'2026-10-02');
    const models=buildModelUsage([stored],'all',timestamp+1).sources.deepseek;
    assert.equal(models.eventCount,105);assert.equal(models.costAvailable,true);assert.equal(models.costCoveragePercent,100);
    const trend=getTrendUsage({unit:'day',count:1},timestamp+3600000,h).sources.deepseek;
    assert.equal(trend.costAvailable,true);
    const receipt=getReceipt(h,{source:'deepseek',date:'2026-10-03'});
    assert.equal(receipt.rows[0].count,105);assert.equal(receipt.rows[0].unpriced,0);assert.equal(receipt.rows[0].costCents,expected);
    assert.match(receipt.costNote,/官方日账单/);assert.match(csvRow(stored),/CNY,0\.73440524,2026-10-03,0\.14915,2026-10-02/);
    h.upsertEvents([{...priced,fxRate:0.2,equivalentCostCents:500}]);
    assert.equal(h.getEvents({sources:'deepseek',end:timestamp+1})[0].fxRate,0.14915);
    assert.equal(h.getEvents({sources:'deepseek',end:timestamp+1})[0].equivalentCostCents,expected);
  }finally{h.close();}
});
test('missing FX leaves the native bill available and missing per-conversation bills remain unpriced; native USD needs no FX',async()=>{
  const h=new UsageHistory(':memory:');
  try{
    const result=await addHistoricalUsdPricing(h,[event()],{fetchFn:async()=>{throw new Error('offline');}});
    assert.equal(result.errors.length,1);assert.equal(result.events[0].billingAmount,'0.73440524');
    assert.equal(billingUsdPricing(result.events[0]),null);assert.equal(priceEvent(result.events[0],null).equivalentCostCents,null);
    assert.equal(priceEvent({...event(),billingAmount:undefined},null).equivalentCostCents,null);
    assert.equal(billingUsdPricing({...event(),billingCurrency:'USD',billingAmount:'1.5'}).equivalentCostCents,150);
    assert.equal(billingUsdPricing({...event(),billingAmount:'-1'}),null);
  }finally{h.close();}
});
test('Harness requests use exclusive Token categories, China holidays and peak boundaries; estimates retain their original price and FX on usage updates',async()=>{
  const h=new UsageHistory(':memory:');
  try{
    const time=Date.parse('2026-10-05T10:00:00+08:00'); // National Day: offpeak despite Monday morning.
    const rows=[{type:'session',id:'fixture',version:4},{type:'request/header',seq:0,data:{header:{config:{model:'deepseek-flash'}}}},
      {type:'assistant/message',seq:1,time,data:{turn:1,step:0,usage:{inputTokens:1000,outputTokens:500,cacheReadTokens:2000,cacheWriteTokens:300}}}];
    const parsed=parseSession(rows.map(row=>JSON.stringify(row)).join('\n')+'\n')[0];
    const native=estimateNativeFee(parsed);
    assert.equal(native.billingKind,'estimated');assert.equal(native.billingBasis.period,'offpeak');
    assert.equal(Number(native.billingAmount),(1300+40+2000)/1e6);
    for(const [date,period] of [['2026-10-08T09:00:00+08:00','peak'],['2026-10-08T12:00:00+08:00','offpeak'],
      ['2026-10-08T14:00:00+08:00','peak'],['2026-10-08T18:00:00+08:00','offpeak'],['2026-10-10T10:00:00+08:00','offpeak']]) {
      assert.equal(estimateNativeFee({...parsed,timestamp:Date.parse(date)}).billingBasis.period,period);
    }
    assert.equal(estimateNativeFee({...parsed,timestamp:Date.parse('2026-04-25T10:00:00+08:00')}).billingAmount,undefined);
    assert.equal(estimateNativeFee({...parsed,model:'unknown'}).billingAmount,undefined);
    const priced=(await addHistoricalUsdPricing(h,[parsed],{fetchFn:async()=>response('2026-10-02')})).events[0];
    h.upsertEvents([priced]);
    const previous=h.getEvents({sources:'deepseek',end:time+1})[0];
    const updated=updateNativeEstimate({...parsed,output:1000},previous);
    const again=await addHistoricalUsdPricing(h,[updated],{fetchFn:async()=>{throw Error('must retain original quote');}});
    assert.equal(again.errors.length,0);h.upsertEvents(again.events);
    const stored=h.getEvents({sources:'deepseek',end:time+1})[0];
    assert.equal(stored.fxRate,0.14915);assert.equal(stored.billingBasis.priceDate,'2026-10-05');
    assert.equal(Number(stored.billingAmount),(1300+40+4000)/1e6);
    assert.equal(stored.equivalentCostCents,Number(stored.billingAmount)*0.14915*100);
    assert.match(getReceipt(h,{source:'deepseek',date:'2026-10-05'}).costNote,/会话估算/);
    const future=estimateNativeFee({...parsed,timestamp:Date.parse('2027-01-04T10:00:00+08:00')});
    assert.equal(future.billingBasis.period,'unknown-holiday');
    const fx={...future,fxRate:0.15,fxDate:'2027-01-04',fxSource:'Frankfurter / ECB'};
    assert.equal(billingUsdPricing(fx).equivalentCostHighCents,2*billingUsdPricing(fx).equivalentCostLowCents);
  }finally{h.close();}
});
