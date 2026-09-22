const fs=require('node:fs');
const {CodexUsageScanner}=require('../src/codex.cjs');

// Fork rollouts contain the parent's session_meta in their copied history.
// The first metadata record identifies the owner; later metadata is history.
class RawQuotaScanner extends CodexUsageScanner {
 parseLine(line,state,file,events){
  let r;try{r=JSON.parse(line)}catch{return;}
  if(r.type==='session_meta'){
   if(state.owner){state.lineNumber=(state.lineNumber||0)+1;return;}
   state.owner=r.payload.id||r.payload.session_id;
   state.ownerCreated=Date.parse(r.payload.timestamp||r.timestamp);
  }
  if(r.type==='event_msg'&&r.payload?.type==='token_count'&&Date.parse(r.timestamp)<state.ownerCreated){
   state.lineNumber=(state.lineNumber||0)+1;return;
  }
  super.parseLine(line,state,file,events);
 }
}

function ownerTimelines(files){
 const sessions=new Map();
 for(const file of files){
  let id=null,born=null;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
   if(!line.includes('"session_meta"')&&!line.includes('"turn_context"'))continue;
   let r;try{r=JSON.parse(line)}catch{continue;}const p=r.payload||{};
   if(r.type==='session_meta'&&!id){id=p.id||p.session_id;born=Date.parse(p.timestamp||r.timestamp);if(id&&!sessions.has(id))sessions.set(id,{parent:p.parent_thread_id||p.forked_from_id||null,models:[]});}
   if(r.type==='turn_context'&&id&&p.model&&Date.parse(r.timestamp)>=born)sessions.get(id).models.push({timestamp:Date.parse(r.timestamp),model:p.model});
  }
 }
 for(const v of sessions.values())v.models.sort((a,b)=>a.timestamp-b.timestamp);
 return sessions;
}
module.exports={RawQuotaScanner,ownerTimelines};
