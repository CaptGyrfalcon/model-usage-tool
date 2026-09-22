const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexUsageScanner,collapseCumulativeEvents}=require('../src/codex.cjs');
const {priceEvent,builtInSnapshot}=require('../src/pricing.cjs');
const {UsageHistory}=require('../src/history.cjs');
const accounting=require('../src/codex-accounting.cjs');
const {Verification,queryAccount}=require('../src/codex-verification.cjs');
test('fixed Luna hypothesis survives catalog refresh; Cursor is isolated; Fast evidence retained',()=>{
 const event={source:'codex',model:'gpt-5.6-luna',input:1e6,cacheRead:1e6,output:1e6,fast:true,fastKnown:false};
 const normal=priceEvent(event,{models:{'gpt-5.6-luna':{standard:{short:{input:99,output:99}}}}});
 assert.ok(Math.abs(normal.equivalentCostCents-236.6666666667)<1e-7);
 assert.ok(Math.abs(priceEvent({...event,fastKnown:true},null).equivalentCostCents-normal.equivalentCostCents*2.5)<1e-7);
 assert.equal(priceEvent({...event,source:'cursor',fast:false,fastKnown:true},builtInSnapshot()).equivalentCostCents,142);
 const q=accounting.quota({windowMinutes:10080,usedPercent:78},'prolite',999);
 assert.equal(q.inferredRemainingCents,49001);assert.equal(q.localEstimatedCostCents,999);
 assert.ok(Math.abs(q.percentUsed-1.998)<1e-10);assert.equal(q.percentRemaining,98.002);
 assert.equal(accounting.capacity('plus',10080),10000);assert.equal(accounting.capacity('prolite',300),null);
});

test('configured first-party capacities use dollars regardless of the server percentage',()=>{
 for(const [plan,total] of [['plus',10000],['prolite',50000],['pro',200000]]){
  const q=accounting.quota({windowMinutes:10080,usedPercent:99},plan,total*.123456);
  assert.ok(Math.abs(q.percentUsed-12.3456)<1e-10);
  assert.ok(Math.abs(q.inferredRemainingCents-total*.876544)<1e-8);
 }
 for(const [plan,total] of [['Pro',45000],['Pro+',120000],['pro_plus',120000],['Ultra',300000]])assert.equal(accounting.cursorCapacity(plan),total);
 assert.equal(accounting.cursorCapacity('unknown'),null);
 assert.equal(accounting.dollarQuota(10000,12000).inferredRemainingCents,0);
 assert.equal(accounting.dollarQuota(10000,12000).percentUsed,120);
});
test('production parser preserves fork owner and charges exactly once per completed review turn',()=>{
 const scan=new CodexUsageScanner('unused'),state={},events=[];
 const add=(type,t,payload)=>scan.parseLine(JSON.stringify({type,timestamp:`2026-09-01T${t}Z`,payload}),state,'fork',events);
 add('session_meta','01:00:00',{id:'child',timestamp:'2026-09-01T01:00:00Z'});
 add('session_meta','00:00:00',{id:'parent',timestamp:'2026-09-01T00:00:00Z'});
 add('turn_context','00:30:00',{model:'wrong',turn_id:'inherited'});
 add('turn_context','01:00:01',{model:'codex-auto-review',turn_id:'review1'});
 for(let i=1;i<=2;i++) add('event_msg',`01:00:0${i+1}`,{type:'token_count',info:{last_token_usage:{input_tokens:10,output_tokens:1},total_token_usage:{input_tokens:10*i,output_tokens:i,total_tokens:11*i}}});
 add('event_msg','01:00:05',{type:'task_complete'});add('event_msg','01:00:05',{type:'task_complete'});
 const ev=collapseCumulativeEvents(events);
 assert.equal(state.sessionId,'child');assert.equal(ev.length,3);
 assert.ok(ev[0].legacyEventKeys.some(k=>k.startsWith('codex:v2:parent:')));
 assert.equal(ev.reduce((sum,e)=>sum+priceEvent(e,null).equivalentCostCents,0),1);
});
test('accounting migration backs up, preserves tokens and Cursor prices, and is idempotent',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'accounting-test-'));let h;
 try {
 h=new UsageHistory(path.join(dir,'history.sqlite'));
 h.upsertEvents(['codex','cursor'].map(source=>({source,eventKey:'original',timestamp:1234,model:'gpt-5.6-luna',input:0,output:1e6,equivalentCostCents:120,pricingStatus:'old'})));
 h.applyCodexAccounting(builtInSnapshot());h.applyCodexAccounting(builtInSnapshot());
 assert.equal(h.getEvent('codex','original').equivalentCostCents,200);
 assert.equal(h.getEvent('codex','original').output,1e6);
 assert.equal(h.getEvent('cursor','original').equivalentCostCents,120);
 assert.equal(fs.readdirSync(dir).filter(n=>n.includes('before-codex')).length,1);
 } finally {h?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('verification saves queries independently, failures, restart state and raw percentage regressions',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verification-test-'));let i=0;
 const query=async()=>({ok:++i!==2,requestStartedAt:Date.now()-5,responseReceivedAt:Date.now(),error:i===2?'timeout':undefined,snapshots:[{limitId:'codex',planType:'prolite',primary:{usedPercent:i===1?78:77,windowDurationMins:10080,resetsAt:2e9}}]});
 try {
 const v=new Verification(dir,query);await v.start();await v.sample();
 assert.equal(v.status().lastSuccess.snapshots[0].primary.usedPercent,78);
 const resumed=new Verification(dir,query);assert.ok(resumed.status().active);await resumed.stop();
 assert.equal(resumed.displayRate().windows[0].usedPercent,77);
 const data=resumed.export({getEvents:()=>[]});assert.equal(data.samples.length,3);
 assert.equal(data.samples.filter(s=>!s.ok).length,1);assert.ok(data.experiment.endedAt);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('query protocol persists only whitelist and times, never server secrets',async()=>{
 const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
 const spawnImpl=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
 c.stdin=new Writable({write(chunk,_enc,cb){const r=JSON.parse(chunk);queueMicrotask(()=>{
 if(r.id===1)c.stdout.write(JSON.stringify({id:1,result:{}})+'\n');
 if(r.id===2)c.stdout.write(JSON.stringify({id:2,result:{secret:'DO_NOT_KEEP',rateLimits:{limitId:'codex',planType:'prolite',primary:{usedPercent:78,windowDurationMins:10080,resetsAt:2e9},email:'private'}}})+'\n');});cb();}});return c;};
 const r=await queryAccount({spawnImpl,command:'mock'});assert.equal(r.ok,true);
 assert.ok(r.responseReceivedAt>=r.requestStartedAt);assert.ok(!JSON.stringify(r).includes('DO_NOT_KEEP'));assert.ok(!JSON.stringify(r).includes('email'));
});

test('background polling runs without an experiment every 15 seconds and never overlaps slow queries',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verification-poll-test-'));
 let now=100000,calls=0,complete;
 const query=()=>{calls++;return new Promise(resolve=>{complete=()=>resolve({ok:true,processStartedAt:now,requestStartedAt:now,responseReceivedAt:now,snapshots:[]});});};
 try {
  const v=new Verification(dir,query,()=>now);
  const first=v.tick();assert.equal(calls,1);assert.equal(v.status().active,undefined);
  complete();await first;
  now+=14999;await v.tick();assert.equal(calls,1);
  now++;const second=v.tick();assert.equal(calls,2);
  now+=20000;const during=v.tick();assert.equal(calls,2);
  complete();await Promise.all([second,during]);
  const third=v.tick();assert.equal(calls,3);complete();await third;
  const samples=fs.readFileSync(v.logPath,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(samples.length,3);assert.equal(samples[1].trigger,'periodic');
  assert.equal(samples[1].previousSuccessfulResponseAt,100000);
  assert.equal(v.status().intervalMs,15000);assert.equal(v.status().backgroundPolling,true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
