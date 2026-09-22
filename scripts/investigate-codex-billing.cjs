// Read-only provenance export. Never export prompts, auth headers, or log bodies.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {sessionFiles}=require('./fit-codex-parent-review.cjs');
const {cumulativeEventKey}=require('../src/codex.cjs');
const old=JSON.parse(fs.readFileSync('out/refit-500/data.json','utf8'));
const start=Math.min(...old.cycles.map(c=>c.start)),end=Math.max(...old.cycles.map(c=>c.samples.at(-1).timestamp));
const db=new DatabaseSync(path.join(process.env.APPDATA,'cursor-usage-widget/usage-history.sqlite'),{readOnly:true});
const events=db.prepare("SELECT event_key,timestamp,model,effort,fast,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,service_tier,tier_source FROM usage_events WHERE source='codex' AND timestamp BETWEEN ? AND ? ORDER BY timestamp").all(start-86400000,end+600000);
const observations=db.prepare('SELECT timestamp,used_percent,window_minutes,resets_at,plan_type,origin,session_id,record_index,quality FROM codex_quota_observations WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp').all(start,end);
db.close();
const bykey=new Map(events.map(e=>[e.event_key,e]));
const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const files=sessionFiles(home,start,end);
// Include archived rollouts, which earlier parent/image scans did not traverse.
function walk(root){if(!fs.existsSync(root))return;for(const e of fs.readdirSync(root,{withFileTypes:true})){let p=path.join(root,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.jsonl'))files.push(p);}}
walk(path.join(home,'archived_sessions'));
let found=0;const extra=[],compactions=[],images=[];
for(const file of files){
 let id=null,model=null,effort=null,previous=null,contextTime=null;
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  if(!line.includes('"session_meta"')&&!line.includes('"turn_context"')&&!line.includes('"token_count"')&&!line.includes('"compacted"')&&!line.includes('imagegen'))continue;
  let r;try{r=JSON.parse(line)}catch{continue}const p=r.payload||{},t=Date.parse(r.timestamp);
  if(r.type==='session_meta'){id=p.id||p.session_id;continue;}
  if(r.type==='turn_context'){model=p.model;effort=p.effort;contextTime=t;continue;}
  if(r.type==='compacted'){compactions.push({id,t});continue;}
  if(r.type==='response_item'&&['custom_tool_call','function_call'].includes(p.type)&&(/imagegen/.test(p.name||'')||/tools\.image_gen__imagegen/.test(p.input||'')))images.push({id,t,name:p.name});
  if(r.type!=='event_msg'||p.type!=='token_count'||!p.info?.total_token_usage)continue;
  const u=p.info.total_token_usage,last=p.info.last_token_usage,key=cumulativeEventKey(id,u);
  if(!key)continue;
  const same=previous&&previous.key===key;
  const delta=previous&&!same?Object.fromEntries(Object.keys(u).map(k=>[k,(u[k]||0)-(previous.u[k]||0)])):null;
  const e=bykey.get(key);
  if(e&&!e.raw){e.raw={model,effort,contextTime,last,total:u,delta,previousTime:previous?.t,contextWindow:p.info.model_context_window};found++;}
  if(!e&&last&&t>=start&&t<=end&&!same)extra.push({key,t,model,last});
  if(!same)previous={u,key,t};
 }
}
fs.mkdirSync('out/billing-investigation',{recursive:true});
fs.writeFileSync('out/billing-investigation/evidence.json',JSON.stringify({events,observations,extra,compactions,images,created:new Date().toISOString()}));
console.log(JSON.stringify({events:events.length,matchedRaw:found,extraRaw:extra.length,observations:observations.length,images:images.length,compactions:compactions.length}));
