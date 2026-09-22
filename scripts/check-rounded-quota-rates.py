"""Fixed model multipliers; LP projection gives exact capacity intersection."""
import importlib.util,json
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
spec=importlib.util.spec_from_file_location('rawfit',Path(__file__).with_name('backtest-raw-quota.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
x=np.array([1,.8,9,1.5]);ids=list(range(2,11))

def constraints(kind,mode,h,lag=0,ids=ids):
    rows=[];rhs=[];counts={};selected=[c for c in m.cycles if c['index'] in ids]
    n=1+len(selected)
    for j,c in enumerate(selected):
        ss=m.select(c,kind);counts[c['index']]=len(ss)
        lo=np.maximum([s['timestamp']-lag*1000 for s in ss],c['start']-300000)
        hi=np.minimum([s.get('confirmedAt',s['timestamp'])+lag*1000 for s in ss],c['end']+300000)
        if c['image']:hi=np.minimum(hi,c['image']-1)
        a=m.cumulative(c,mode,lo)@x;b=m.cumulative(c,mode,hi)@x
        for s,low,high in zip(ss,a,b):
            p=s['percent'];v=np.zeros(n);v[0]=-(p+h);v[j+1]=1
            if p<100:rows.append(v);rhs.append(-low)
            v=np.zeros(n);v[0]=p-h;v[j+1]=-1;rows.append(v);rhs.append(high)
    return np.array(rows),np.array(rhs),counts

def solve(kind,mode,h,lag=0,ids=ids):
    A,b,counts=constraints(kind,mode,h,lag,ids);n=A.shape[1];obj=np.zeros(n);obj[0]=1;bounds=[(1e-6,None)]+[(0,None)]*(n-1)
    low=linprog(obj,A_ub=A,b_ub=b,bounds=bounds,method='highs')
    fixed=linprog(np.zeros(n),A_ub=A,b_ub=b,bounds=[(1,1)]+bounds[1:],method='highs')
    out={'kind':kind,'review':mode,'halfWidth':h,'extraSeconds':lag,'counts':counts,'feasible':low.success,'nominal100_500':fixed.success}
    if low.success:
        high=linprog(-obj,A_ub=A,b_ub=b,bounds=bounds,method='highs')
        out.update(scale=[float(low.fun),float(-high.fun)],plus=[float(low.fun*100),float(-high.fun*100)],pro=[float(low.fun*500),float(-high.fun*500)])
        witness=fixed if fixed.success else low
        assert max(A@witness.x-b)<1e-6
        out['witness']={'scale':float(witness.x[0]),'initialBalancesNormalized':witness.x[1:].tolist()}
    return out

def min_error(kind,mode,fixed=False):
    a=0.;b=10.
    for _ in range(38):
        h=(a+b)/2;r=solve(kind,mode,h)
        if r['nominal100_500'] if fixed else r['feasible']:b=h
        else:a=h
    return b

results=[solve(kind,mode,h,lag) for kind in ['confirmed','crossing'] for mode in ['free','sol','parent'] for h in [.5,1] for lag in [0,60]]
individual=[{'index':i,**solve('confirmed','free',1,ids=[i])} for i in ids]
byplan={p:{str(h):solve('confirmed','free',h,ids=ii) for h in [.5,1]} for p,ii in [('plus',[2,3,4,5]),('pro',[6,7,8,9,10])]}
witnesses={}
for plan,ii,s in [('plus',[2,3,4,5],.9881),('pro',[6,7,8,9,10],1.)]:
    A,b,counts=constraints('confirmed','free',1,ids=ii);n=A.shape[1]
    w=linprog(np.zeros(n),A_ub=A,b_ub=b,bounds=[(s,s)]+[(0,None)]*(n-1),method='highs')
    assert w.success and max(A@w.x-b)<1e-7
    witnesses[plan]={'capacity':s*(100 if plan=='plus' else 500),'maxConstraintViolation':float(max(A@w.x-b)),'initialNormalizedBalances':w.x[1:].tolist()}
out={'fixedMultipliers':dict(zip(m.models,x)),'results':results,'perCycleFreeAt1':individual,'byPlan':byplan,'verifiedWitnesses':witnesses,'minimumHalfWidth':{'freeCapacity':min_error('confirmed','free'),'fixed100_500':min_error('confirmed','free',True)}}
(m.P/'rounded-rates.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
print(json.dumps(out,indent=2))
