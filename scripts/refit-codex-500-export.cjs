// Read-only input extraction; all output stays in out/refit-500.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {weeklyCycles,imageCalls,sessionModel}=require('./audit-codex-price-scenarios.cjs');
const {sessionFiles,parentTimelines}=require('./fit-codex-parent-review.cjs');
const prices=require('../src/pricing.cjs').builtInSnapshot().models;
// Database input_tokens is already UNCACHED input (src/codex.cjs).
function rateCost(e,m){const p=prices[m].standard.short;return (e.input_tokens*p.input+e.cache_read_tokens*p.cacheRead+e.cache_write_tokens*p.cacheWrite+e.output_tokens*p.output)/1e6;}
const db=new DatabaseSync(path.join(process.env.APPDATA,'cursor-usage-widget/usage-history.sqlite'),{readOnly:true});
const cycles=weeklyCycles(db),home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const files=sessionFiles(home,Math.min(...cycles.map(c=>c.reset-604800000)),Date.now());
const sessions=parentTimelines(files),images=imageCalls(files);
const models=['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-6-astra'];
const reports=[];
for(const c of cycles){
 const start=c.reset-604800000,end=Math.min(c.reset,c.samples.at(-1).timestamp);
 const image=images.find(t=>t>=start&&t<=end);
 const samples=c.samples.filter(s=>s.timestamp>=start&&s.timestamp<=end&&(image==null||s.timestamp<image));
 const report={plan:c.plan,capacity:c.plan==='plus'?100:500,reset:c.reset,start,image:image??null,samples,events:[]};
 if(samples.length>=2){
  const rows=db.prepare("SELECT event_key,timestamp,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,fast FROM usage_events WHERE source='codex' AND timestamp>? AND timestamp<=? AND lower(model) NOT LIKE '%spark%' ORDER BY timestamp").all(samples[0].timestamp,samples.at(-1).timestamp);
  for(const e of rows){
   const model=e.model==='unknown'?sessionModel(e,sessions):e.model;
   const parent=model==='codex-auto-review'?sessionModel(e,sessions,true):null;
   report.events.push({...e,model,parent,base:models.map(m=>rateCost(e,m)),factor:e.fast===1?2.5:1});
  }
 }
 reports.push(report);
}
db.close();
fs.mkdirSync('out/refit-500',{recursive:true});
fs.writeFileSync('out/refit-500/data.json',JSON.stringify({created:new Date().toISOString(),models,images,cycles:reports}));
console.log(JSON.stringify(reports.map(c=>({...c,samples:c.samples.length,events:c.events.length,first:c.samples[0],last:c.samples.at(-1),unresolved:c.events.filter(e=>!models.includes(e.model)&&!(e.model==='codex-auto-review'&&models.includes(e.parent))).length})),null,2));
