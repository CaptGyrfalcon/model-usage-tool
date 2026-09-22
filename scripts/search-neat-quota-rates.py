import importlib.util,json,itertools
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
s=importlib.util.spec_from_file_location('b',Path(__file__).with_name('backtest-raw-quota.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
blocks=[]
for c in m.cycles[2:]:
 ss=m.select(c,'confirmed');A=m.cumulative(c,'free',[s['timestamp'] for s in ss]);B=m.cumulative(c,'free',[s['confirmedAt'] for s in ss]);y=np.array([s['percent'] for s in ss]);blocks.append((c,A,B,y))

def assess(x,h=1):
 gaps=[];offsets=[];rms=[]
 for c,A,B,y in blocks:
  lower=max(0,float(max(y-h-B@x)));upper=float(min(y+h-A@x));gaps.append(lower-upper);offsets.append([lower,upper]);rms.extend(A@x+(lower+upper)/2-y)
 return {'multipliers':list(map(float,x)),'feasible':max(gaps)<=1e-9,'worstGap':max(gaps),'initialIntervals':offsets,'midpointOffsetPointRMSE':float(np.sqrt(np.mean(np.array(rms)**2)))}

def search(sols,terras,lunas,astras):
 grid=np.array(list(itertools.product(terras,lunas)));found=[];tested=0
 for sol,astra in itertools.product(sols,astras):
  xs=np.column_stack([np.full(len(grid),sol),grid,np.full(len(grid),astra)]);ok=np.ones(len(xs),bool)
  for c,A,B,y in blocks:
   ix=np.flatnonzero(ok)
   if not len(ix):break
   lower=np.maximum(0,np.max(y[:,None]-1-B@xs[ix].T,axis=0));upper=np.min(y[:,None]+1-A@xs[ix].T,axis=0);ok[ix]=lower<=upper+1e-9
  found.extend(xs[ok].tolist());tested+=len(xs)
 return {'tested':tested,'feasibleCount':len(found),'feasible':found}

named=[assess(np.array(x)) for x in [[1,.8,9,1.5],[1.01,.8,9,1.5],[1.015,.8,9,1.5],[1.02,.8,9,1.5],[1.025,.8,9,1.5],[1.0125,.8,9,1.5],[1.0125,1,9,1.5],[1.025,1,9,1.5]]]
coarse=search(np.arange(.8,1.301,.05),np.arange(0,3.01,.1),np.arange(0,20.01,.5),np.arange(1,2.001,.05))
fine=search(np.arange(.95,1.101,.005),np.arange(0,2.01,.1),np.arange(5,14.01,.5),np.arange(1.4,1.601,.01))
chosen=np.array([1.02,.8,9,1.5]);witness=assess(chosen)
minh=max(max(0.,-float(min(y-A@chosen)),float((max(y-B@chosen)-min(y-A@chosen))/2)) for c,A,B,y in blocks)
rows=[];rhs=[];baseline=np.array([0,.8,9,1.5]);n=1+len(blocks)
for k,(c,A,B,y) in enumerate(blocks):
 for a,b,p in zip(A,B,y):
  v=np.zeros(n);v[0]=a[0];v[k+1]=1;rows.append(v);rhs.append(p+1-a@baseline)
  v=np.zeros(n);v[0]=-b[0];v[k+1]=-1;rows.append(v);rhs.append(-p+1+b@baseline)
objective=np.r_[1,np.zeros(len(blocks))]
low=linprog(objective,A_ub=rows,b_ub=rhs,bounds=[(0,None)]*n,method='highs');high=linprog(-objective,A_ub=rows,b_ub=rhs,bounds=[(0,None)]*n,method='highs')
fixed=linprog(np.zeros(n),A_ub=rows,b_ub=rhs,bounds=[(1.02,1.02)]+[(0,None)]*len(blocks),method='highs')
assert fixed.success and max(np.array(rows)@fixed.x-rhs)<1e-7
witness.update(minimumHalfWidth=minh,feasibleSolRange=[low.fun,-high.fun],independentLPVerified=True,initialBalances=dict(zip([str(c['index']) for c,A,B,y in blocks],fixed.x[1:])))
out={'modelOrder':m.models,'named':named,'coarse':coarse,'fine':fine,'recommended':witness}
(m.P/'neat-rates.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
print('named',json.dumps(named,indent=2));print('coarse',coarse);print('fine count',fine['feasibleCount'],'examples',fine['feasible'][:20])
