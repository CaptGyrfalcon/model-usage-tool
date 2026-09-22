"""Fit independent review prices against frozen, corrected raw-log observations.
All prices are conditional equivalents under assumed Plus100/Pro500 capacities.
The count feature is a usage-event proxy, NOT verified review invocation count.
"""
import importlib.util,json
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
s=importlib.util.spec_from_file_location('b',Path(__file__).with_name('backtest-raw-quota.py'))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

def block(c,kind='confirmed',lag=0):
 ss=m.select(c,kind);ts=[];vs=[]
 for e in sorted(c['events'],key=lambda e:e['timestamp']):
  v=np.zeros(7);f=2.5 if e['fast'] is True else 1
  if e['model']=='codex-auto-review':
   o=(e['base'][1]-.5*e['base'][0])/2;u=(e['base'][0]-20*o)/4
   assert min(u,o)>-1e-9
   v[4:]=[max(0,u)*f,max(0,o)*f,f]
  elif e['model'] in m.models:v[m.models.index(e['model'])]=e['base'][m.models.index(e['model'])]*f
  elif max(e['base'])>0:raise ValueError(e)
  vs.append(v*100/c['capacity']);ts.append(e['timestamp'])
 cs=np.vstack([np.zeros(7),np.cumsum(vs,axis=0)]);base=cs[np.searchsorted(ts,c['start'],side='right')]
 lo=np.maximum([s['timestamp']-lag*1000 for s in ss],c['start']-300000)
 hi=np.minimum([s.get('confirmedAt',s['timestamp'])+lag*1000 for s in ss],min(c['end']+300000,c['image']-1 if c['image'] else np.inf))
 return {'cycle':c['index'],'A':cs[np.searchsorted(ts,lo,side='right')]-base,'B':cs[np.searchsorted(ts,hi,side='right')]-base,'y':np.array([s['percent'] for s in ss])}

def fit(review='sol_shape',main='sol_fixed',ids=range(2,11),lag=0,kind='confirmed',h=None,coef=None):
 bs=[block(c,kind,lag) for c in m.cycles if c['index'] in ids]
 n=7+len(bs)+1;rows=[];rhs=[]
 for k,b in enumerate(bs):
  for a,z,y in zip(b['A'],b['B'],b['y']):
   row=np.zeros(n);row[:7]=a;row[7+k]=1;row[-1]=-1
   if y<100:rows.append(row);rhs.append(y)
   row=np.zeros(n);row[:7]=-z;row[7+k]=-1;row[-1]=-1;rows.append(row);rhs.append(-y)
 bounds=[(0,None)]*n;eq=[]
 if main=='sol_fixed':bounds[0]=(1,1)
 elif main=='sol_luna_fixed':bounds[0]=(1,1);bounds[2]=(1,1)
 elif main=='luna_fixed':bounds[2]=(1,1)
 elif main=='all_standard':bounds[:4]=[(1,1)]*4
 elif main=='rounded':bounds[:4]=[(v,v) for v in [1,.8,9,1.5]]
 elif main=='integer_outputs':bounds[:4]=[(v,v) for v in [1,10/12,10,1.5]]
 elif main!='all_free':raise ValueError(main)
 if review in ['free','sol_shape','tokens']:bounds[6]=(0,0)
 if review in ['free','count']:bounds[4:6]=[(0,0)]*2
 if review=='sol_shape':
  row=np.zeros(n);row[5]=1;row[4]=-5;eq.append(row)
 if coef is not None:bounds[:7]=[(v,v) for v in coef]
 if h is not None:bounds[-1]=(h,h)
 kw=dict(A_ub=rows,b_ub=rhs,A_eq=eq or None,b_eq=[0]*len(eq) if eq else None,bounds=bounds,method='highs')
 obj=np.zeros(n);obj[-1]=1;r=linprog(obj,**kw)
 if not r.success:return {'success':False}
 x=r.x;errors=[];parts=[]
 for k,b in enumerate(bs):
  residual=np.maximum.reduce([b['A']@x[:7]+x[7+k]-b['y'],b['y']-b['B']@x[:7]-x[7+k],np.zeros(len(b['y']))]);errors.extend(residual)
  parts.append({'cycle':b['cycle'],'n':len(b['y']),'maxIntervalError':float(max(residual)),'initialPercent':float(x[7+k]),'reviewPercentOverObservedSpan':float((b['A'][-1,4:]-b['A'][0,4:])@x[4:7])})
 out={'success':True,'review':review,'main':main,'lag':lag,'kind':kind,'halfWidth':float(x[-1]),'coefficients':x[:7].tolist(),'n':len(errors),'intervalRMSE':float(np.sqrt(np.mean(np.square(errors)))),'cycles':parts}
 if h is not None and coef is None:
  ranges=[]
  for j in range(7):
   obj=np.zeros(n);obj[j]=1;l=linprog(obj,**kw);u=linprog(-obj,**kw)
   ranges.append([float(l.x[j]) if l.success else None,float(u.x[j]) if u.success else None])
  out['coefficientRanges']=ranges
 return out

if __name__=='__main__':
 results=[]
 for main in ['sol_fixed','rounded','integer_outputs','all_standard','all_free']:
  for review in ['free','sol_shape','tokens','count','tokens_count']:
   r=fit(review,main);results.append(r);print(main,review,round(r['halfWidth'],6),np.round(r['coefficients'],6).tolist(),flush=True)
 sensitivity=[fit(review,main,ids=ids,lag=lag,kind=kind) for main in ['sol_fixed','rounded'] for review in ['sol_shape','tokens','count'] for ids,lag,kind in [(range(11),0,'confirmed'),(range(2,11),60,'confirmed'),(range(2,11),0,'crossing')]]
 feasible=[fit(review,main,h=1) for main in ['sol_fixed','rounded','integer_outputs'] for review in ['sol_shape','tokens','count']]
 # Leave-one-cycle-out: fit shared prices on eight cycles; held-out cycle gets
 # only its own unknown initial balance, never a refitted price coefficient.
 cv=[]
 for review in ['free','sol_shape','tokens','count']:
  tests=[]
  for held in range(2,11):
   train=fit(review,ids=[i for i in range(2,11) if i!=held]);test=fit(review,ids=[held],coef=train['coefficients']);tests.append({'held':held,'trainHalfWidth':train['halfWidth'],'testHalfWidth':test['halfWidth'],'coefficients':train['coefficients']})
  cv.append({'review':review,'folds':tests,'maxHeldHalfWidth':max(t['testHalfWidth'] for t in tests),'meanHeldHalfWidth':float(np.mean([t['testHalfWidth'] for t in tests]))})
 (m.P/'independent-review.json').write_text(json.dumps({'results':results,'sensitivity':sensitivity,'at1':feasible,'leaveOneCycleOut':cv},indent=2),encoding='utf-8')
