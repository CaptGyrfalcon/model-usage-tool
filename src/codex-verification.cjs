const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const { APP_DIR } = require("./history.cjs");
const accounting = require("./codex-accounting.cjs");
const POLL_INTERVAL_MS = 15000;

function executable() {
  const root = path.join(process.env.LOCALAPPDATA || "", "OpenAI/Codex/bin");
  const files = fs.existsSync(root) ? fs.readdirSync(root).map(d=>path.join(root,d,"codex.exe"))
    .filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs) : [];
  return files[0] || "codex";
}
function cleanSnapshot(s) {
  const window = w => w && Number.isFinite(w.usedPercent) && Number.isFinite(w.windowDurationMins)
    ? { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt ?? null } : null;
  return { limitId: s.limitId || "codex", planType: s.planType || null,
    primary: window(s.primary), secondary: window(s.secondary) };
}
function queryAccount({ spawnImpl = spawn, command = executable(), timeoutMs = 20000 } = {}) {
  const processStartedAt = Date.now();
  return new Promise((resolve) => {
    let child, lines, timer, finished = false, requestStartedAt = null;
    const done = (result) => {
      if (finished) return; finished = true;
      clearTimeout(timer); lines?.close(); child?.stdin?.end(); child?.kill();
      resolve({ id: randomUUID(), origin: "account/rateLimits/read", processStartedAt,
        requestStartedAt, responseReceivedAt: Date.now(), ...result });
    };
    try { child = spawnImpl(command,["app-server"],{ windowsHide: true, stdio: ["pipe","pipe","pipe"] }); }
    catch { done({ ok: false, error: "无法启动 Codex app-server" }); return; }
    child.on("error",()=>done({ok:false,error:"无法启动 Codex app-server"}));
    child.on("exit",()=>done({ok:false,error:"Codex 查询进程提前退出"}));
    child.stdin.on("error",()=>done({ok:false,error:"Codex 查询连接已关闭"}));
    // Do not persist stderr, headers, auth, prompts, or unrestricted response bodies.
    child.stderr.resume();
    timer=setTimeout(()=>done({ok:false,error:"主动查询超时"}),timeoutMs);
    lines=createInterface({input:child.stdout});
    const send = r => child.stdin.write(JSON.stringify(r)+"\n");
    lines.on("line",line=>{
      let r; try {r=JSON.parse(line);} catch{return;}
      if (r.id===1) {
        if (r.error) {done({ok:false,error:"Codex 初始化失败"});return;}
        send({method:"initialized",params:{}});
        requestStartedAt=Date.now();send({id:2,method:"account/rateLimits/read",params:{}});
      } else if (r.id===2) {
        if (r.error) {done({ok:false,error:`额度查询失败（${r.error.code ?? "unknown"}）`});return;}
        const value=r.result;
        if (!value?.rateLimits && !value?.rateLimitsByLimitId) {done({ok:false,error:"额度返回格式不受支持"});return;}
        const snapshots=Object.values(value.rateLimitsByLimitId || {codex:value.rateLimits}).filter(Boolean).map(cleanSnapshot);
        done({ok:true,snapshots});
      }
    });
    send({id:1,method:"initialize",params:{clientInfo:{name:"usage_widget_verification",version:"1.0.0"},capabilities:{experimentalApi:true}}});
  });
}
class Verification {
  constructor(dir=APP_DIR,query=queryAccount,now=Date.now) {
    this.dir=dir; this.query=query; this.pending=null; this.now=now; this.lastPollStartedAt=null;
    this.statePath=path.join(dir,"codex-verification-state.json");
    this.logPath=path.join(dir,"codex-verification.jsonl");
    try {this.state=JSON.parse(fs.readFileSync(this.statePath,"utf8"));} catch {this.state={};}
  }
  save() {fs.mkdirSync(this.dir,{recursive:true});const temp=this.statePath+".tmp";fs.writeFileSync(temp,JSON.stringify(this.state));fs.renameSync(temp,this.statePath);}
  append(r) {fs.mkdirSync(this.dir,{recursive:true});fs.appendFileSync(this.logPath,JSON.stringify(r)+"\n");}
  status() {return {...this.state,logPath:this.logPath,intervalMs:POLL_INTERVAL_MS,backgroundPolling:true,accountingVersion:accounting.VERSION};}
  async sample(trigger="manual") {
    if (this.pending) return this.pending;
    this.lastPollStartedAt=this.now();
    this.pending=(async()=>{
      const record=await this.query();record.experimentId=this.state.active?.id || null;
      record.trigger=trigger;record.pollIntervalMs=POLL_INTERVAL_MS;
      record.previousSuccessfulResponseAt=this.state.lastSuccess?.responseReceivedAt ?? null;
      record.accountingVersion=accounting.VERSION;this.append({type:"sample",...record});
      this.state.lastAttempt=record;
      if(record.ok)this.state.lastSuccess=record;
      this.save();return this.status();
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async tick() {
    // Start-to-start cadence; never overlap or replay missed ticks after sleep.
    if(this.lastPollStartedAt==null || this.now()-this.lastPollStartedAt>=POLL_INTERVAL_MS)await this.sample("periodic");
    return this.status();
  }
  async start() {
    if(this.state.active)return this.status();
    await this.pending;
    this.state.active={id:randomUUID(),startedAt:Date.now(),accountingVersion:accounting.VERSION,rates:accounting.RATES};
    this.append({type:"start",...this.state.active});this.save();await this.sample("experiment-start");return this.status();
  }
  async stop() {
    if(!this.state.active)return this.status();
    await this.pending;await this.sample("experiment-stop");
    this.state.lastExperiment={...this.state.active,endedAt:Date.now()};
    this.append({type:"stop",...this.state.lastExperiment});this.state.active=null;this.save();return this.status();
  }
  export(history) {
    const exp=this.state.active || this.state.lastExperiment;
    const records=fs.existsSync(this.logPath)?fs.readFileSync(this.logPath,"utf8").trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l)):[];
    const start=exp?.startedAt || Date.now()-86400000,end=exp?.endedAt || Date.now();
    const samples=records.filter(r=>exp?r.experimentId===exp.id:r.responseReceivedAt>=start);
    const events=history.getEvents({sources:"codex",start:start-120000,end:end+120000});
    const within=events.filter(e=>e.timestamp>=start && e.timestamp<=end);
    const models={};let unknownFast=0,reviewTurns=0,unpriced=0;
    for(const e of within) {
      const model=models[e.model] ||= {events:0,costCents:0,input:0,cacheRead:0,cacheWrite:0,output:0};
      model.events++;model.costCents+=e.equivalentCostCents || 0;
      for(const key of ["input","cacheRead","cacheWrite","output"])model[key]+=e[key] || 0;
      if(!e.fastKnown)unknownFast++;
      if(String(e.eventKey).startsWith("codex:review-turn:"))reviewTurns++;
      if(e.equivalentCostCents==null)unpriced++;
    }
    const weekly=samples.filter(r=>r.ok).flatMap(r=>{
      const s=r.snapshots.find(s=>s.limitId==="codex");
      const w=[s?.primary,s?.secondary].find(w=>w?.windowDurationMins===10080);
      return w?[{requestStartedAt:r.requestStartedAt,responseReceivedAt:r.responseReceivedAt,planType:s.planType,...w}]:[];
    });
    const changes=weekly.slice(1).flatMap((w,i)=>w.usedPercent===weekly[i].usedPercent && w.resetsAt===weekly[i].resetsAt && w.planType===weekly[i].planType?[]:[{previous:weekly[i],next:w,
      resetOrPlanChanged:w.resetsAt!==weekly[i].resetsAt || w.planType!==weekly[i].planType,
      usedPercentDelta:w.usedPercent-weekly[i].usedPercent}]);
    return {schemaVersion:1,exportedAt:Date.now(),experiment:exp||null,accounting:{version:accounting.VERSION,rates:accounting.RATES,reviewPerTurnUSD:.01,plusWeeklyUSD:100,pro5xWeeklyUSD:500},
      samples,events,summary:{models,unknownFast,reviewTurns,unpriced,failedQueries:samples.filter(s=>!s.ok).length,weeklyChanges:changes},
      note:"保留两侧120秒用量；整数余额、非实时结算。检查模型混用、未知Fast、跨重置和未完请求；不要把缓存快照混入独立查询。"};
  }
  displayRate(now=Date.now()) {
    const r=this.state.lastSuccess;
    if(!r || now-r.responseReceivedAt>120000)return null;
    const s=r.snapshots.find(s=>s.limitId==="codex");if(!s)return null;
    const windows=["primary","secondary"].flatMap(slot=>s[slot]?[{slot,usedPercent:s[slot].usedPercent,
      percentRemaining:Math.max(0,100-s[slot].usedPercent),windowMinutes:s[slot].windowDurationMins,
      resetsAt:s[slot].resetsAt==null?null:s[slot].resetsAt*1000,sampledAt:r.responseReceivedAt,planType:s.planType}]:[]);
    return {timestamp:r.responseReceivedAt,planType:s.planType,windows,origin:r.origin,shortLimit:windows.some(w=>w.windowMinutes===300)?"present":"absent"};
  }
}
let singleton;
function getVerification(){return singleton ||= new Verification();}
module.exports={queryAccount,cleanSnapshot,Verification,getVerification};
