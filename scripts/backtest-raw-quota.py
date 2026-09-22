import json
from pathlib import Path
import numpy as np
from scipy.optimize import linprog,nnls
P=Path(__file__).resolve().parents[1]/'out/raw-quota-backtest'
d=json.loads((P/'data.json').read_text());models=d['models'];cycles=d['cycles']

def select(c,kind):
    ss=c['samples']
    if kind=='raw':return ss
    seen={};fresh=[]
    for s in ss:
        key=(s['origin'],s['session']);last=seen.get(key,-1)
        if s['percent']>last:fresh.append(s);seen[key]=s['percent']
    if kind=='fresh':return fresh
    crossings=[];high=-1
    for s in fresh:
        if s['percent']>high:crossings.append(s);high=s['percent']
    if kind=='crossing':return crossings
    confirmed=[]
    for a in crossings:
        candidates=[b for b in fresh if a['timestamp']<=b['timestamp']<=a['timestamp']+120000 and b['percent']==a['percent'] and b['session']!=a['session']]
        if candidates:
            b=candidates[0]
            if not any(a['timestamp']<v['timestamp']<b['timestamp'] and v['percent']>a['percent'] for v in fresh):
                confirmed.append({**a,'confirmedAt':b['timestamp']})
    return confirmed

def cumulative(c,mode,times):
    vs=[];ts=[]
    for e in sorted(c['events'],key=lambda e:e['timestamp']):
        m=e['model']
        if m=='codex-auto-review':
            if mode=='free':continue
            m=models[0] if mode=='sol' else e['parent']
        if m not in models:
            if max(e['base'])>0:raise ValueError('Unresolved nonzero model')
            continue
        j=models.index(m);v=np.zeros(4);v[j]=e['base'][j]*(2.5 if e['fast'] is True else 1)*100/c['capacity'];vs.append(v);ts.append(e['timestamp'])
    cs=np.vstack([np.zeros(4),np.cumsum(vs,axis=0)]);base=cs[np.searchsorted(ts,c['start'],side='right')]
    return cs[np.searchsorted(ts,times,side='right')]-base

def evaluate(kind,mode,lag=0,lead=0,ids=None):
    selected=[(c,select(c,kind)) for c in cycles if ids is None or c['index'] in ids]
    selected=[(c,ss) for c,ss in selected if len(ss)>=3 and ss[-1]['percent']-ss[0]['percent']>=3]
    n=4+len(selected)+1;rows=[];rhs=[];design=[];targets=[];counts={};intervals=[]
    for k,(c,ss) in enumerate(selected):
        counts[c['index']]=len(ss)
        times=np.array([s['timestamp'] for s in ss]);low=np.maximum(times-lag*1000,c['start']-300000)
        upper=np.array([s.get('confirmedAt',s['timestamp']) for s in ss])+lead*1000
        upper=np.minimum(upper,c['end']+300000)
        if c['image']:upper=np.minimum(upper,c['image']-1)
        al=cumulative(c,mode,low);au=cumulative(c,mode,upper);am=cumulative(c,mode,times)
        for s,a,b,v in zip(ss,al,au,am):
            intervals.append((s,a,b,k))
            row=np.zeros(n);row[:4]=a;row[4+k]=1;row[-1]=-1
            if s['percent']<100:rows.append(row);rhs.append(s['percent'])
            row=np.zeros(n);row[:4]=-b;row[4+k]=-1;row[-1]=-1;rows.append(row);rhs.append(-s['percent'])
            x=np.zeros(n-1);x[:4]=v;x[4+k]=1;design.append(x);targets.append(s['percent'])
    bounds=[(0,None)]*(n-1)+[(0,None)]
    lp=linprog([0]*(n-1)+[1],A_ub=rows,b_ub=rhs,bounds=bounds,method='highs')
    if not lp.success:raise RuntimeError(lp.message)
    A=np.array(design);y=np.array(targets);x=nnls(A,y,maxiter=10000)[0];err=A@x-y
    # Explicit h=0.5 and h=1 feasibility checks, retaining physical initial balances.
    feasible={}
    for h in [.5,1]:
        check=linprog([0]*n,A_ub=rows,b_ub=rhs,bounds=bounds[:-1]+[(h,h)],method='highs');feasible[str(h)]=check.success
    # Constructive common-capacity intersection at +/-1, fixing this witness's
    # price coefficients and initial dollar balances, keeping Pro:Plus=5:1.
    lower=0.;upper=float('inf')
    for s,a,b,k in intervals:
        balance=lp.x[4+k];p=s['percent']
        if p<100:lower=max(lower,float((a@lp.x[:4]+balance)/(p+1)))
        if p>1:upper=min(upper,float((b@lp.x[:4]+balance)/(p-1)))
    return {'kind':kind,'mode':mode,'lag':lag,'lead':lead,'cycles':counts,'n':len(y),'halfWidth':float(lp.fun),'feasible':feasible,
       'initialPercentBalances':{str(c['index']):float(lp.x[4+i]) for i,(c,ss) in enumerate(selected)},
       'capacityScaleAt1':{'lower':lower,'upper':upper,'nonempty':lower<=upper},
       'intervalMultipliers':dict(zip(models,lp.x[:4])),'pointRMSE':float(np.sqrt(np.mean(err**2))),'pointMaxError':float(max(abs(err))),
       'pointMultipliers':dict(zip(models,x[:4]))}

if __name__=='__main__':
    results=[]
    for kind in ['raw','fresh','crossing','confirmed']:
        for mode in ['free','sol','parent']:
            r=evaluate(kind,mode);results.append(r);print(kind,mode,r['n'],round(r['halfWidth'],3),round(r['pointRMSE'],3),flush=True)
    sensitivity=[]
    for kind in ['crossing','confirmed']:
        for mode in ['free','sol','parent']:
            for lag,lead in [(30,0),(60,0),(120,0),(300,0),(30,30),(60,60),(120,120),(300,300)]:
                r=evaluate(kind,mode,lag,lead);sensitivity.append(r)
    groups=[{'group':name,**evaluate('crossing',mode,ids=ids)} for name,ids in [('pro',[6,7,8,9,10]),('drop2',list(range(2,11)))] for mode in ['free','sol','parent']]
    out={'results':results,'timingSensitivity':sensitivity,'subgroups':groups}
    (P/'fit.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
    print('sensitivity',[(r['kind'],r['mode'],r['lag'],r['lead'],round(r['halfWidth'],3)) for r in sensitivity if r['feasible']['1']])
