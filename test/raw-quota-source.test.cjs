const test=require('node:test'),assert=require('node:assert/strict');
const {RawQuotaScanner}=require('../scripts/raw-quota-source.cjs');
test('fork owner survives inherited metadata; inherited token observations are excluded',()=>{
 const scan=new RawQuotaScanner('unused'),state={},events=[];
 const add=(type,time,payload)=>scan.parseLine(JSON.stringify({type,timestamp:time,payload}),state,'fork.jsonl',events);
 add('session_meta','2026-09-01T01:00:00Z',{id:'child',timestamp:'2026-09-01T01:00:00Z'});
 add('session_meta','2026-09-01T00:00:00Z',{id:'parent',timestamp:'2026-09-01T00:00:00Z'});
 const payload={type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:0,output_tokens:10,total_tokens:110},last_token_usage:{input_tokens:100,output_tokens:10,total_tokens:110}}};
 add('event_msg','2026-09-01T00:30:00Z',payload);
 assert.equal(events.length,0);
 add('turn_context','2026-09-01T01:00:01Z',{model:'gpt-5.6-luna'});
 add('event_msg','2026-09-01T01:01:00Z',payload);
 assert.equal(events.length,1);assert.equal(state.sessionId,'child');assert.ok(events[0].eventKey.startsWith('codex:v2:child:'));assert.equal(events[0].model,'gpt-5.6-luna');assert.equal(state.lineNumber,5);
});
