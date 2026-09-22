"""Audit raw review turns, then replace usage-event proxy with unique turns."""
import importlib.util,json,collections
from pathlib import Path
import numpy as np
s=importlib.util.spec_from_file_location('f',Path(__file__).with_name('fit-independent-review.py'));f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
events={e['key']:e for c in f.m.cycles for e in c['events'] if e['model']=='codex-auto-review'}
ids={e['key'].split(':')[2] for e in events.values()};turns={};matches={};types=collections.Counter()
def ms(t):
 from datetime import datetime
 return int(datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000)
for root in ['sessions','archived_sessions']:
 for p in (Path.home()/'.codex'/root).rglob('*.jsonl'):
  if not any(i in p.name for i in ids):continue
  owner=None;born=0;current=None;model=None
  for line in p.open(encoding='utf-8'):
   try:r=json.loads(line)
   except ValueError:continue
   q=r.get('payload') or {};typ=r.get('type');stamp=ms(r['timestamp']) if r.get('timestamp') else 0
   if typ=='session_meta' and owner is None:owner=q.get('id');born=ms(q.get('timestamp',r['timestamp']))
   if stamp<born:continue
   if typ=='turn_context':
    current=q.get('turn_id');model=q.get('model')
    if model=='codex-auto-review' and current:turns.setdefault((owner,current),{'session':owner,'turn':current,'start':stamp,'complete':None,'tokenTimes':[]})
   if model!='codex-auto-review' or not current:continue
   k=(owner,current)
   if typ=='event_msg' and q.get('type')=='token_count':
    turns[k]['tokenTimes'].append(stamp);matches[(owner,stamp)]=k
   if typ=='event_msg' and q.get('type')=='task_complete':turns[k]['complete']=stamp
unmatched=[]
for e in events.values():
 k=matches.get((e['key'].split(':')[2],e['timestamp']))
 if k is None:unmatched.append(e['key']);continue
 turns[k].setdefault('eventKeys',[]).append(e['key']);turns[k]['fast']=turns[k].get('fast',False) or e['fast'] is True
assert not unmatched,unmatched
used=[t for t in turns.values() if t.get('eventKeys')]
audit={'distinctReviewEvents':len(events),'matchedTurns':len(used),'eventsPerTurn':dict(collections.Counter(len(t['eventKeys']) for t in used)),'missingCompletion':sum(t['complete'] is None for t in used),'turns':used}
(f.m.P/'review-turn-audit.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
print('audit',{k:v for k,v in audit.items() if k!='turns'},flush=True)
original=f.block
def make_block(timing,fast_multiplier):
 def block(c,kind='confirmed',lag=0):
  b=original(c,kind,lag);ss=f.m.select(c,kind)
  ts=[];vs=[]
  # Include review turns even if they had no positive token delta.
  for t in turns.values():
   if timing=='start':stamp=t['start']
   elif timing=='complete':stamp=t['complete'] or (max(t['tokenTimes']) if t['tokenTimes'] else t['start'])
   else:stamp=max(t['tokenTimes']) if t['tokenTimes'] else (t['complete'] or t['start'])
   ts.append(stamp);vs.append(2.5 if fast_multiplier and t.get('fast') else 1)
  order=np.argsort(ts);ts=np.array(ts)[order];cs=np.r_[0,np.cumsum(np.array(vs)[order])]*100/c['capacity'];base=cs[np.searchsorted(ts,c['start'],side='right')]
  lo=np.maximum([s['timestamp']-lag*1000 for s in ss],c['start']-300000)
  hi=np.minimum([s.get('confirmedAt',s['timestamp'])+lag*1000 for s in ss],min(c['end']+300000,c['image']-1 if c['image'] else np.inf))
  b['A'][:,6]=cs[np.searchsorted(ts,lo,side='right')]-base;b['B'][:,6]=cs[np.searchsorted(ts,hi,side='right')]-base
  return b
 return block
results=[]
for timing in ['last_token','complete','start']:
 for fast in [True,False]:
  f.block=make_block(timing,fast)
  for main in ['sol_luna_fixed','luna_fixed','all_standard','sol_fixed']:
   r=f.fit('count',main);r.update(timing=timing,fastReview=fast);results.append(r)
   print(timing,fast,main,round(r['halfWidth'],6),np.round(r['coefficients'],6).tolist(),flush=True)
f.block=make_block('complete',True)
sensitivity=[f.fit('count','sol_luna_fixed',lag=t) for t in [60,120,300]]
combined=[f.fit(mode,'sol_luna_fixed') for mode in ['sol_shape','tokens','tokens_count']]
ranges=[f.fit('count','sol_fixed',h=1),f.fit('count','luna_fixed',h=1)]
neat=[]
for terra in [1,1.05,1.1,1.15,1.2]:
 for fee in [.0025,.005,.0075,.01]:
  r=f.fit('count','sol_luna_fixed',lag=60,coef=[1,terra,1,1.5,0,0,fee]);neat.append(r)
neat.sort(key=lambda r:r['halfWidth'])
print('neat',[(r['coefficients'],r['halfWidth']) for r in neat[:5]])
out={'audit':{k:v for k,v in audit.items() if k!='turns'},'results':results,'timingSensitivity':sensitivity,'combined':combined,'rangesAt1':ranges,'neatAt60Seconds':neat}
(f.m.P/'review-per-turn.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
rows=['# Auto-review 按完整审查 turn 固定计费','',
'原始日志606条review用量事件映射到583个唯一(session,turn_id)，均存在task_complete。范围是冻结数据中出现review用量的线程；未记录的服务端调用或完全没有用量记录的独立线程不在本次计数中。多数turn只有一次用量事件，17个turn有多次。统计583包含原始11周期涉及的事件；拟合仍只用剔除两个异常Plus周期后的9周期、228个确认观测。','',
'按turn完成时间记账；每个turn固定费用独立于父模型及token数。测试fast收费与不收费结果相同。Plus100/Pro5x500，主模型fast2.5倍，未知non-fast。每周期初始已用额度非负自由。','',
'| 主模型约束 | 最小容差（百分点） | Sol/Terra/Luna/Astra倍率 | 每turn等效美元 |','|---|---:|---|---:|']
for r in results:
 if r['timing']=='complete' and r['fastReview']:
  rows.append(f"| {r['main']} | ±{r['halfWidth']:.6f} | {r['coefficients'][:4]} | {r['coefficients'][6]:.8f} |")
rows+=['','sol_luna_fixed: Sol和Luna均1；luna_fixed: 仅Luna固定1；all_standard: 四模型均1；sol_fixed: 仅Sol固定1。','',
'## 额外扣量时间不确定性的敏感性','',
'下列在原有首次观测至跨会话确认的区间之外再向前后各扩展，属于假设，不是确认存在的服务端延迟。','']
for r in sensitivity:rows.append(f"- ±{r['lag']}秒：Sol/Luna固定1，最小容差±{r['halfWidth']:.6f}；其余参数{r['coefficients']}。")
rows+=['','## 简单候选（额外±60秒）','']
for r in neat[:5]:rows.append(f"- 倍率{r['coefficients'][:4]}；每turn ${r['coefficients'][6]}；最小容差±{r['halfWidth']:.6f}。")
rows+=['','结论：无额外时延时，Luna原价+按次review仍略超±1门槛；但额外60秒不确定性足以改变是否相容的判断，不能据此认定Luna必须9倍。全部主模型原价则明显不相容。按token或token+按次的混合模型在固定Sol/Luna1时也不能消除无额外时延的矛盾。','',
'Radar的1145未参与本次拟合，缺少其工作负载、审查次数和金额定义，因此本结果不能单独验证或解释该数值。此处美元是100/500容量假设下的等效扣量，不是已确认的官方账单价。']
(f.m.P/'review-per-turn-report.md').write_text('\n'.join(rows)+'\n',encoding='utf-8')
