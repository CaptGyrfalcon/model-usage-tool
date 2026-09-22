import importlib.util,json
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('f',Path(__file__).with_name('fit-full-cycle-pattern.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
tokens=json.loads((f.OUT/'tokens.json').read_text())
rates=[[4,.4,20],[2,.2,12],[1/3,1/30,2],[15,1.5,75]]
f.names=[m+'_'+component for m in ['sol','terra','luna','astra'] for component in ['input','cache','output']]+['review','image']
baseline=np.array(sum(rates,[])+[.01,.15])
def blocks(lag=60,kind='confirmed',ids=range(2,11)):
 result=[]
 for c in f.d['cycles']:
  if c['index'] not in ids:continue
  ss=f.m.select(c,kind)
  if len(ss)<3:continue
  ev=[]
  for e in c['events']:
   v=np.zeros(14)
   if e['model'] in f.models:
    j=f.models.index(e['model'])*3;t=tokens[e['key']];factor=(2.5 if t['fast'] else 1)/1e6
    # Cache write retains its 1.25x uncached-input ratio.
    v[j:j+3]=np.array([t['input']+1.25*t['cacheWrite'],t['cacheRead'],t['output']])*factor
   elif e['key'].startswith('codex:review-turn:'):v[12]=1
   ev.append((e['timestamp'],v))
  for e in c['images']:
   if e.get('status')=='not-executed':continue
   v=np.zeros(14);v[13]=e['count'];ev.append((e['timestamp'],v))
  ev.sort(key=lambda e:e[0]);ts=[e[0] for e in ev]
  cs=np.vstack([np.zeros(14),np.cumsum([e[1] for e in ev],axis=0)])*100/c['capacity'];zero=cs[np.searchsorted(ts,c['start'],side='right')]
  def at(times):return cs[np.searchsorted(ts,times,side='right')]-zero
  lo=at([max(c['start']-300000,s['timestamp']-lag*1000) for s in ss]);hi=at([min(c['end']+300000,s.get('confirmedAt',s['timestamp'])+lag*1000) for s in ss])
  result.append((c,ss,lo,hi))
 return result

if __name__=='__main__':
 results=[]
 for lag in [0,60,120,300]:
  bb=blocks(lag)
  for label,free in [('astra-components',[9,10,11]),('astra-components-image',[9,10,11,13]),('all-components-fees-fixed',list(range(12))),('all-components',list(range(14)))]:
   fixed={j:float(v) for j,v in enumerate(baseline) if j not in free}
   r={'mode':label,'lag':lag,**f.fit(bb,fixed)};results.append(r);print(json.dumps(r),flush=True)
 (f.OUT/'components.json').write_text(json.dumps(results,indent=2))
