// Read-only raw-log export; no changes to the widget database.
const fs=require('node:fs');
const {RawQuotaScanner,ownerTimelines}=require('./raw-quota-source.cjs');
const {sessionModel}=require('./audit-codex-price-scenarios.cjs');
const {RATES}=require('../src/codex-accounting.cjs');
const old=JSON.parse(fs.readFileSync('out/refit-500/data.json','utf8'));
const scanner=new RawQuotaScanner(undefined,{fullHistory:true}),scan=scanner.scan();
if(scan.scanErrors.length)throw Error(JSON.stringify(scan.scanErrors));
const files=scanner.files(),sessions=ownerTimelines(files),images=new Map();
for(const file of files){
 let owner,born;const pending=new Map(),cells=new Map();
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  if(!line.includes('session_meta')&&!line.includes('response_item'))continue;
  let r;try{r=JSON.parse(line)}catch{continue;}const p=r.payload||{},t=Date.parse(r.timestamp);
  if(r.type==='session_meta'&&!owner){owner=p.id||p.session_id;born=Date.parse(p.timestamp||r.timestamp);}
  if(!owner||t<born||r.type!=='response_item')continue;
  const input=String(p.input||p.arguments||'');
  if(p.type==='function_call'&&/wait$/.test(p.name||'')){try{const a=JSON.parse(input),x=cells.get(String(a.cell_id));if(x)pending.set(p.call_id,x);}catch{}}
  const count=p.type==='custom_tool_call'?(input.match(/tools\.image_gen__imagegen\s*\(/g)||[]).length:
    p.type==='function_call'&&/imagegen$/.test(p.name||'')?1:0;
  if(count){const key=owner+':'+p.call_id;const x={key,owner,timestamp:t,count,name:p.name,completedAt:null,outputSize:null,outputExcerpt:null};images.set(key,x);pending.set(p.call_id,x);}
  if(/tool_call_output|function_call_output/.test(p.type||'')&&pending.has(p.call_id)){
   const x=pending.get(p.call_id),s=typeof p.output==='string'?p.output:JSON.stringify(p.output);
   const cell=/Script running with cell ID (\S+)/.exec(s||'');
   x.outputSize=s?.length;x.status=/SyntaxError:/.test(s||'')?'not-executed':/Script failed|Script error:/.test(s||'')?'failed':cell?'running':'completed';
   if(cell){cells.set(cell[1],x);x.completedAt=null;}else{x.completedAt=t;}
   x.outputExcerpt=(s||'').replace(/data:image\/[^"\s]+/g,'[image omitted]').slice(0,400);pending.delete(p.call_id);
  }
 }
}
const events=scan.events.filter(e=>!e.model.includes('spark')).map(e=>{
 const model=e.model==='unknown'?sessionModel({...e,event_key:e.eventKey},sessions):e.model;
 const rate=RATES[model];let cost;
 if(model==='codex-auto-review')cost=e.eventKey.startsWith('codex:review-turn:')?.01:0;
 else if(rate)cost=(e.input*rate.input+e.cacheRead*rate.cacheRead+e.cacheWrite*rate.cacheWrite+e.output*rate.output)/1e6*(e.fastKnown&&e.fast?2.5:1);
 else cost=e.input||e.cacheRead||e.output?null:0;
 return {timestamp:e.timestamp,key:e.eventKey,model,cost};
});
const all=scan.quotaSamples.filter(s=>s.quality==='valid'&&s.windowMinutes===10080);
const cycles=old.cycles.map((c,index)=>{
 const start=c.samples[0].timestamp;
 const next=old.cycles.slice(index+1).find(n=>n.plan===c.plan&&n.reset>c.reset+60000);
 const stop=Math.min(c.reset,next?next.samples[0].timestamp-1:Date.now());
 const samples=all.filter(s=>s.planType===c.plan&&Math.abs(s.resetsAt-c.reset)<=60000&&s.timestamp>=start&&s.timestamp<=stop).map(s=>({timestamp:s.timestamp,percent:s.usedPercent,session:s.sessionId,origin:s.origin})).sort((a,b)=>a.timestamp-b.timestamp);
 const end=samples.at(-1)?.timestamp||start;
 return {index,plan:c.plan,capacity:c.capacity,reset:c.reset,start,end,oldEnd:c.samples.at(-1).timestamp,samples,
  events:events.filter(e=>e.timestamp>start-300000&&e.timestamp<=end+300000),
  images:[...images.values()].filter(e=>e.timestamp>start-300000&&e.timestamp<=end+300000)};
});
fs.mkdirSync('out/image-flat-fee',{recursive:true});
fs.writeFileSync('out/image-flat-fee/data.json',JSON.stringify({created:new Date().toISOString(),cycles,images:[...images.values()]}));
console.log(JSON.stringify(cycles.map(c=>({index:c.index,start:new Date(c.start),end:new Date(c.end),samples:c.samples.length,images:c.images.length,unknown:c.events.filter(e=>e.cost==null).length})),null,2));
console.log(JSON.stringify(cycles.filter(c=>c.images.length).map(c=>({index:c.index,statuses:c.images.reduce((a,e)=>(a[e.status]=(a[e.status]||0)+1,a),{}),multi:c.images.filter(e=>e.count!==1).length})),null,2));
