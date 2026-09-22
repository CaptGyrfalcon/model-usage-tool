"""Fit fixed per-model output-equivalent rates and flat review/image fees.
Reads frozen corrected raw data; never changes live prices or source data.
"""
import json,importlib.util,itertools
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'out/full-cycle-pattern';OUT.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('raw',Path(__file__).with_name('backtest-raw-quota.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
d=json.loads((ROOT/'out/image-flat-fee/data.json').read_text())
names=['sol','terra','luna','astra','review','image'];models=['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-6-astra']
base=np.array([20,12,2,75,.01,.15])

def blocks(lag=60,kind='confirmed',ids=range(2,11),timing='timestamp'):
 result=[]
 for c in d['cycles']:
  if c['index'] not in ids:continue
  ss=m.select(c,kind)
  if len(ss)<3:continue
  ev=[]
  for e in c['events']:
   v=np.zeros(6)
   if e['model'] in models:
    j=models.index(e['model']);v[j]=e['cost']/base[j]
   elif e['key'].startswith('codex:review-turn:'):v[4]=1
   elif e['cost']:raise ValueError(e)
   ev.append((e['timestamp'],v))
  for e in c['images']:
   if e.get('status')=='not-executed':continue
   v=np.zeros(6);v[5]=e['count'];ev.append((e.get(timing) or e['timestamp'],v))
  ev.sort(key=lambda e:e[0]);ts=[e[0] for e in ev]
  cs=np.vstack([np.zeros(6),np.cumsum([e[1] for e in ev],axis=0)])*100/c['capacity']
  zero=cs[np.searchsorted(ts,c['start'],side='right')]
  def at(times):return cs[np.searchsorted(ts,times,side='right')]-zero
  lower=at([max(c['start']-300000,s['timestamp']-lag*1000) for s in ss])
  upper=at([min(c['end']+300000,s.get('confirmedAt',s['timestamp'])+lag*1000) for s in ss])
  result.append((c,ss,lower,upper))
 return result

def fit(bb,fixed=None,h=None,ranges=False):
 fixed=fixed or {};p=len(names);n=p+len(bb)+1;rows=[];rhs=[]
 for k,(c,ss,lo,hi) in enumerate(bb):
  for s,a,b in zip(ss,lo,hi):
   row=np.zeros(n);row[:p]=a;row[p+k]=1;row[-1]=-1
   if s['percent']<100:rows.append(row);rhs.append(s['percent'])
   row=np.zeros(n);row[:p]=-b;row[p+k]=-1;row[-1]=-1
   rows.append(row);rhs.append(-s['percent'])
 bounds=[(0,None)]*n
 for j,v in fixed.items():bounds[j]=(v,v)
 if h is not None:bounds[-1]=(h,h)
 ob=np.zeros(n);ob[-1]=1
 r=linprog(ob,A_ub=rows,b_ub=rhs,bounds=bounds,method='highs')
 if not r.success:return {'feasible':False}
 result={'feasible':True,'halfWidth':float(r.x[-1]),'rates':dict(zip(names,r.x[:p])),
 'balances':{c['index']:float(r.x[p+k]) for k,(c,ss,lo,hi) in enumerate(bb)},'samples':sum(len(ss) for c,ss,lo,hi in bb)}
 if ranges:
  rr={};br=bounds[:-1]+[(1,1)]
  for j,name in enumerate(names):
   ob=np.zeros(n);ob[j]=1
   a=linprog(ob,A_ub=rows,b_ub=rhs,bounds=br,method='highs');b=linprog(-ob,A_ub=rows,b_ub=rhs,bounds=br,method='highs')
   rr[name]=[float(a.x[j]),float(b.x[j]) if b.success else None] if a.success else None
  result['marginalRangesAt1']=rr
 return result

if __name__=='__main__':
 results=[]
 modes={'baseline':dict(enumerate(base)), 'astra-only':{j:base[j] for j in [0,1,2,4,5]},
 'astra-image':{j:base[j] for j in [0,1,2,4]},
 'sol-fixed-review-fixed':{0:20,4:.01},'models-free-fees-fixed':{4:.01,5:.15},
 'sol-fixed-all-fees-free':{0:20},'all-free':{}}
 for lag in [0,30,60,120,300]:
  bb=blocks(lag)
  for name,fixed in modes.items():
   r={'mode':name,'lag':lag,**fit(bb,fixed,ranges=lag==60)};results.append(r)
   print(json.dumps(r),flush=True)
 (OUT/'fits.json').write_text(json.dumps(results,indent=2))
