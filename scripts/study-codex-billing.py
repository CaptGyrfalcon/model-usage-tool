"""Compare falsifiable accounting mechanisms on the same frozen observations."""
import json
from pathlib import Path
import numpy as np
from scipy.optimize import nnls,linprog
P=Path(__file__).resolve().parents[1]/'out'
d=json.loads((P/'refit-500/data.json').read_text());evidence=json.loads((P/'billing-investigation/evidence.json').read_text())
models=d['models'];cycles=d['cycles'];raw={e['event_key']:e for e in evidence['events']}

def blocks(mode,kind='base',lag=0,fast=2.5):
    names=models.copy()
    if kind in ['request','unknown','fastfree','reasoning']:names += [m+':'+kind for m in models]
    if kind=='reviewfree':names+=['review-sol']
    result=[]
    for c in cycles:
        events=c['events'];features=[];ts=[]
        for e in events:
            m=e['model'];review=m=='codex-auto-review'
            if review:
                if mode=='free' and kind!='reviewfree':continue
                m=models[0] if mode!='parent' else e['parent']
            if m not in models:continue
            j=models.index(m);v=np.zeros(len(names));f=fast if e['fast']==1 else 1
            v[j]=e['base'][j]*f
            if review and kind=='reviewfree':v[:]=0;v[-1]=e['base'][0]*f
            elif kind=='request':v[j+4]=f
            elif kind=='unknown' and e['fast'] is None:v[j+4]=v[j];v[j]=0
            elif kind=='fastfree' and e['fast']==1:v[j+4]=e['base'][j];v[j]=0
            elif kind=='reasoning':v[j+4]=raw[e['event_key']]['reasoning_tokens']/1e6*f
            # Scope ends at the original last observation; positive lag cannot use unseen events.
            features.append(v*100/c['capacity']);ts.append(e['timestamp'])
        cs=np.vstack([np.zeros(len(names)),np.cumsum(features,axis=0)])
        times=np.array([s['timestamp'] for s in c['samples']])+lag*1000
        idx=np.searchsorted(ts,times,side='right')
        A=cs[idx];A-=A[0];y=np.array([s['percent'] for s in c['samples']]);y=y-y[0]
        result.append((A,y))
    return names,result

def fit(bs,names):
    A=np.vstack([a[1:] for a,y in bs]);y=np.concatenate([y[1:] for a,y in bs]);x=nnls(A,y,maxiter=10000)[0];err=A@x-y
    width=len(names);n=width+len(bs)+1;rows=[];rhs=[]
    for i,(a,yc) in enumerate(bs):
        for v,p in zip(a,yc):
            row=np.zeros(n);row[:width]=v;row[width+i]=1;row[-1]=-1
            rows.append(row);rhs.append(p)
            row=row.copy();row[:-1]*=-1;rows.append(row);rhs.append(-p)
    # Liberal offsets: allow negatives even at 0% for mechanism screening only.
    lp=linprog([0]*(n-1)+[1],A_ub=rows,b_ub=rhs,bounds=[(0,None)]*width+[(None,None)]*len(bs)+[(0,None)],method='highs')
    cv=[]
    for i,(a,yc) in enumerate(bs):
        ta=np.vstack([a[1:] for k,(a,y) in enumerate(bs) if k!=i]);ty=np.concatenate([y[1:] for k,(a,y) in enumerate(bs) if k!=i]);tx=nnls(ta,ty,maxiter=10000)[0]
        cv.extend(a[1:]@tx-yc[1:])
    return {'rmse':float(np.sqrt(np.mean(err**2))),'max':float(max(abs(err))),'outside1':int(sum(abs(err)>1)),
            'locoRMSE':float(np.sqrt(np.mean(np.array(cv)**2))),'liberalMinHalfWidth':float(lp.fun),'coefficients':dict(zip(names,x))}

out=[]
for mode in ['free','sol','parent']:
    for kind in ['base','request','unknown','fastfree','reasoning','reviewfree']:
        names,bs=blocks(mode,kind)
        r={'review':mode,'kind':kind,'all':fit(bs,names),'pro':fit(bs[6:],names),'drop2':fit(bs[2:],names)};out.append(r)
        print(mode,kind,'all/pro/drop2',*[round(r[k]['rmse'],3) for k in ['all','pro','drop2']], 'cv',round(r['all']['locoRMSE'],3),'minwidth',round(r['all']['liberalMinHalfWidth'],3),flush=True)
lags=[]
for mode in ['free','sol','parent']:
    for lag in [-120,-60,-30,-10,-1,0,1,10,30,60,120]:
        names,bs=blocks(mode,lag=lag);r={'review':mode,'lagSeconds':lag,'all':fit(bs,names),'pro':fit(bs[6:],names)};lags.append(r)
(P/'billing-investigation/candidates.json').write_text(json.dumps({'candidates':out,'lags':lags},indent=2),encoding='utf-8')
for mode in ['free','sol','parent']:
    best=min([r for r in lags if r['review']==mode],key=lambda r:r['all']['rmse']);print('lag best',mode,best['lagSeconds'],best['all']['rmse'])
