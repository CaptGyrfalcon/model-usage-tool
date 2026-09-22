// Fresh in-memory scan: no widget DB reads/writes; prior file supplies comparison windows only.
const fs=require('node:fs');
const {RawQuotaScanner,ownerTimelines}=require('./raw-quota-source.cjs');
const {sessionModel}=require('./audit-codex-price-scenarios.cjs');
const prices=require('../src/pricing.cjs').builtInSnapshot().models;
const old=JSON.parse(fs.readFileSync('out/refit-500/data.json','utf8'));
const scanner=new RawQuotaScanner(undefined,{fullHistory:true}),scan=scanner.scan();
if(scan.scanErrors.length)throw Error(JSON.stringify(scan.scanErrors));
const sessions=ownerTimelines(scanner.files());
const models=old.models;
const result=old.cycles.map((c,i)=>{
 const start=c.samples[0].timestamp,end=c.samples.at(-1).timestamp;
 const events=scan.events.filter(e=>e.timestamp>start-300000&&e.timestamp<=end+300000&&(!c.image||e.timestamp<c.image)&&!e.model.includes('spark')).map(e=>{
  const shim={...e,event_key:e.eventKey};const model=e.model==='unknown'?sessionModel(shim,sessions):e.model;
  const parent=model==='codex-auto-review'?sessionModel(shim,sessions,true):null;
  const base=models.map(m=>{const p=prices[m].standard.short;return (e.input*p.input+e.cacheRead*p.cacheRead+e.cacheWrite*p.cacheWrite+e.output*p.output)/1e6;});
  return {timestamp:e.timestamp,key:e.eventKey,model,parent,fast:e.fastKnown?e.fast:null,base};
 });
 const samples=scan.quotaSamples.filter(s=>s.quality==='valid'&&s.windowMinutes===10080&&s.planType===c.plan&&Math.abs(s.resetsAt-c.reset)<=60000&&s.timestamp>=start&&s.timestamp<=end).map(s=>({timestamp:s.timestamp,percent:s.usedPercent,session:s.sessionId,origin:s.origin,reset:s.resetsAt,path:s.originPath,line:s.recordIndex})).sort((a,b)=>a.timestamp-b.timestamp);
 return {index:i,plan:c.plan,capacity:c.capacity,start,end,image:c.image,events,samples,previousSamples:c.samples};
});
fs.mkdirSync('out/raw-quota-backtest',{recursive:true});
fs.writeFileSync('out/raw-quota-backtest/data.json',JSON.stringify({created:new Date().toISOString(),models,cycles:result}));
console.log(JSON.stringify(result.map(c=>({index:c.index,events:c.events.length,samples:c.samples.length,unresolved:c.events.filter(e=>!models.includes(e.model)&&!(e.model==='codex-auto-review'&&models.includes(e.parent))).length})),null,2));
