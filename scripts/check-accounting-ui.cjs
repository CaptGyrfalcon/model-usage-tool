// Isolated Electron render smoke test; synthetic accounts only, never starts the widget worker.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
app.setPath('userData',path.join(root,'out/accounting-ui-profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:600,height:900,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
 const errors=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
 await w.loadFile(path.join(root,'src/renderer/index.html'),{query:{preview:'1'}});
 await new Promise(r=>setTimeout(r,500));
 const checks=await w.webContents.executeJavaScript(`(async()=>{
   settings.orbMode=false;settings.activeTab='overview';settings.compact=false;
   const d=snapshot.data;
   for(const q of codexQuotaWindows(d.codex))if(q.windowMinutes===10080){q.usedPercent=78;q.percentRemaining=22;q.quotaEstimate={estimateStatus:'local-dollar-usage',inferredTotalCents:50000,inferredRemainingCents:11000,usedCents:39000};}
   render();
   const before=document.querySelector('#codexPool').innerText;
   let recording=false;
   window.widget.verification=async(action)=>{if(action==='start')recording=true;if(action==='stop')recording=false;return {active:recording?{id:'test'}:null,lastSuccess:{responseReceivedAt:Date.now(),snapshots:[{limitId:'codex',primary:{usedPercent:78,windowDurationMins:10080}}]}};};
   document.querySelector('[data-verification="start"]').click();await new Promise(r=>setTimeout(r,20));
   const started=document.querySelector('#verificationStatus').innerText.includes('记录中') && !document.querySelector('[data-verification="stop"]').disabled;
   document.querySelector('[data-verification="stop"]').click();await new Promise(r=>setTimeout(r,20));
   const stopped=document.querySelector('[data-verification="stop"]').disabled;
   document.querySelector('#verificationPanel').scrollIntoView({block:'end'});
   return {loaded:Boolean(d),capacity:before.includes('$500'),assumption:before.includes('假设'),started,stopped,overflow:document.body.scrollWidth>innerWidth};
 })()`);
 fs.mkdirSync(path.join(root,'out/accounting-ui'),{recursive:true});
 await new Promise(r=>setTimeout(r,400));
 fs.writeFileSync(path.join(root,'out/accounting-ui/verification.png'),(await w.webContents.capturePage()).toPNG());
 console.log(JSON.stringify({checks,errors}));
 fs.writeFileSync(path.join(root,'out/accounting-ui/result.json'),JSON.stringify({checks,errors},null,2));
 app.exit(errors.length || !checks.loaded || !checks.capacity || !checks.assumption || !checks.started || !checks.stopped || checks.overflow ? 1:0);
}).catch(e=>{console.error(e);app.exit(1);});
