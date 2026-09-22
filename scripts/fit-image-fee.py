import json,importlib.util
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
P=Path(__file__).resolve().parents[1]/'out/image-flat-fee'
spec=importlib.util.spec_from_file_location('raw',Path(__file__).with_name('backtest-raw-quota.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
d=json.loads((P/'data.json').read_text())
for c in d['cycles']:c['images']=[e for e in c['images'] if e.get('status')!='not-executed']

def fit(lag=0,kind='confirmed',timing='timestamp',fixed=None,ids=range(2,11)):
 selected=[(c,m.select(c,kind)) for c in d['cycles'] if c['index'] in ids]
 selected=[(c,s) for c,s in selected if len(s)>=3]
 n=len(selected)+2;rows=[];rhs=[];counts={}
 for k,(c,ss) in enumerate(selected):
  ev=[(e['timestamp'],e['cost'],0) for e in c['events'] if e['cost'] is not None]
  ev += [(e.get(timing) or e['timestamp'],0,e['count']) for e in c['images']]
  ev.sort();ts=[e[0] for e in ev];cs=np.vstack([np.zeros(2),np.cumsum([e[1:] for e in ev],axis=0)])*100/c['capacity']
  base=cs[np.searchsorted(ts,c['start'],side='right')]
  def at(t):return cs[np.searchsorted(ts,t,side='right')]-base
  counts[c['index']]={'samples':len(ss),'images':sum(e['count'] for e in c['images'] if c['start']<e['timestamp']<=ss[-1]['timestamp']),'lastPercent':ss[-1]['percent']}
  for s in ss:
   a=at(max(c['start']-300000,s['timestamp']-lag*1000));b=at(min(c['end']+300000,s.get('confirmedAt',s['timestamp'])+lag*1000))
   row=np.zeros(n);row[0]=a[1];row[1+k]=1;row[-1]=-1
   if s['percent']<100:rows.append(row);rhs.append(s['percent']-a[0])
   row=np.zeros(n);row[0]=-b[1];row[1+k]=-1;row[-1]=-1
   rows.append(row);rhs.append(b[0]-s['percent'])
 bounds=[(0,None)]*n
 if fixed is not None:bounds[0]=(fixed,fixed)
 objective=np.zeros(n);objective[-1]=1
 r=linprog(objective,A_ub=rows,b_ub=rhs,bounds=bounds,method='highs')
 if not r.success:return {'error':r.message}
 ranges={}
 for h in [.5,1,1.5,2,float(r.fun)+1e-7]:
  br=bounds[:-1]+[(h,h)];ob=np.zeros(n);ob[0]=1
  lo=linprog(ob,A_ub=rows,b_ub=rhs,bounds=br,method='highs');hi=linprog(-ob,A_ub=rows,b_ub=rhs,bounds=br,method='highs')
  ranges[str(h)]=[float(lo.x[0]),float(hi.x[0]) if hi.success else 'unbounded'] if lo.success else None
 return {'lag':lag,'kind':kind,'timing':timing,'fixed':fixed,'fee':float(r.x[0]),'halfWidth':float(r.fun),'ranges':ranges,'counts':counts,'balances':{c['index']:float(r.x[k+1]) for k,(c,s) in enumerate(selected)}}

results=[]
for timing in ['timestamp','completedAt']:
 for lag in [0,30,60,120,300]:
  for fixed in [None,0,.1,.15,.25,.5,1,2,5]:
   results.append(fit(lag=lag,timing=timing,fixed=fixed))
results += [fit(lag=60,kind='crossing'),fit(lag=60,ids=range(11))]
results += [dict(fit(lag=60,ids=[i]),subset=i) for i in range(2,11)]
results += [dict(fit(lag=lag,ids=[9],fixed=price,timing=timing),subset=9) for lag in [0,30,60,120,300] for price in [None,0,.1,.15,.2] for timing in ['timestamp','completedAt']]
(P/'fit.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
for r in results:
 if r.get('fixed') is None:print(json.dumps({k:v for k,v in r.items() if k not in ['counts','balances']}))
