"""Fit shared nonnegative model price multipliers with fixed weekly budgets."""
import json
from pathlib import Path
import numpy as np
from scipy.optimize import nnls, linprog

ROOT=Path(__file__).resolve().parents[1]/'out/refit-500'
data=json.loads((ROOT/'data.json').read_text())
models=data['models']

def matrix(c,mode):
    total=np.zeros(4); rows=[]; ys=[]; j=0
    for s in c['samples']:
        while j<len(c['events']) and c['events'][j]['timestamp']<=s['timestamp']:
            e=c['events'][j]; j+=1
            m=e['model']
            if m=='codex-auto-review':
                if mode=='free': continue
                m=models[0] if mode=='sol' else e['parent']
            if m not in models:
                if any(e[k] for k in ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens']):
                    raise ValueError(f'Unresolved event: {e}')
                continue
            k=models.index(m); total[k]+=e['base'][k]*e['factor']*100/c['capacity']
        rows.append(total.copy()); ys.append(s['percent']-c['samples'][0]['percent'])
    return np.array(rows[1:]),np.array(ys[1:])

def metrics(A,y,x):
    err=A@x-y
    return dict(rmse=float(np.sqrt(np.mean(err**2))),mae=float(np.mean(abs(err))),maxError=float(max(abs(err))),outside1=int(sum(abs(err)>1)),n=len(y))

def fit(blocks):
    A=np.vstack([b[0] for b in blocks]); y=np.concatenate([b[1] for b in blocks])
    x=nnls(A,y)[0]
    # Smallest possible worst absolute error; stronger than an OLS rejection.
    lp=linprog([0]*4+[1],A_ub=np.vstack([np.c_[A,-np.ones(len(y))],np.c_[-A,-np.ones(len(y))]]),b_ub=np.r_[y,-y],bounds=[(0,None)]*5,method='highs')
    return dict(multiplier=dict(zip(models,x)),**metrics(A,y,x),minimumMaxError=float(lp.fun),minimaxMultiplier=dict(zip(models,lp.x[:4])))

cycles=[c for c in data['cycles'] if len(c['samples'])>=3]
out={'models':models,'cycles':[{k:v for k,v in c.items() if k not in ['events','samples']}|{'first':c['samples'][0],'last':c['samples'][-1],'events':len(c['events']),'observations':len(c['samples']),'reviewEvents':sum(e['model']=='codex-auto-review' for e in c['events']),'fast':sum(e['fast']==1 for e in c['events']),'unspecifiedFast':sum(e['fast'] is None for e in c['events'])} for c in cycles],'scenarios':{}}
for mode in ['free','sol','parent']:
    blocks=[matrix(c,mode) for c in cycles]
    r=fit(blocks); x=np.array(list(r['multiplier'].values()))
    r['perCycle']=[]
    cv=[]
    for i,(A,y) in enumerate(blocks):
        local=fit([(A,y)])
        train=[b for k,b in enumerate(blocks) if k!=i]
        tx=np.array(list(fit(train)['multiplier'].values()))
        cv.extend((A@tx-y).tolist())
        r['perCycle'].append({'global':metrics(A,y,x),'local':local,'heldOut':metrics(A,y,tx),'contribution':dict(zip(models,A[-1]))})
    r['heldOutRMSE']=float(np.sqrt(np.mean(np.array(cv)**2)))
    r['byPlan']={p:fit([b for b,c in zip(blocks,cycles) if c['plan']==p]) for p in ['plus','prolite']}
    r['intervalFit']=fit([(np.diff(np.vstack([np.zeros(4),A]),axis=0),np.diff(np.r_[0,y])) for A,y in blocks])
    # Sensitivity: latest cycle with Sol at the previous 1x anchor.
    A,y=blocks[-1]; active=[1,2,3]
    ax=np.r_[1,nnls(A[:,active],y-A[:,0])[0]]
    r['latestSol1']=dict(multiplier=dict(zip(models,ax)),**metrics(A,y,ax))
    # Let input, cache-read, output prices vary independently (12 coefficients).
    components=[]
    for c in cycles:
        total=np.zeros(12); rows=[]; j=0
        for s in c['samples']:
            while j<len(c['events']) and c['events'][j]['timestamp']<=s['timestamp']:
                e=c['events'][j];j+=1;m=e['model']
                if m=='codex-auto-review':
                    if mode=='free':continue
                    m=models[0] if mode=='sol' else e['parent']
                if m not in models:continue
                if e['cache_write_tokens']:raise ValueError('Cache-write requires a fourth token component')
                k=models.index(m)*3
                total[k:k+3]+=np.array([e['input_tokens'],e['cache_read_tokens'],e['output_tokens']])*e['factor']*100/c['capacity']/1e6
            rows.append(total.copy())
        components.extend(rows[1:])
    A=np.array(components);y=np.concatenate([b[1] for b in blocks]);cx=nnls(A,y)[0]
    lp=linprog([0]*12+[1],A_ub=np.vstack([np.c_[A,-np.ones(len(y))],np.c_[-A,-np.ones(len(y))]]),b_ub=np.r_[y,-y],bounds=[(0,None)]*13,method='highs')
    r['independentTokenPrices']=dict(prices={m:cx[i*3:i*3+3].tolist() for i,m in enumerate(models)},**metrics(A,y,cx),minimumMaxError=float(lp.fun))
    out['scenarios'][mode]=r
(ROOT/'fit.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
print(json.dumps(out,indent=2))
