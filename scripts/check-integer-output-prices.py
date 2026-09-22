import importlib.util,json,collections
from pathlib import Path
import numpy as np
s=importlib.util.spec_from_file_location('b',Path(__file__).with_name('backtest-raw-quota.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
# input+0.1*cache can be recovered exactly from the two independent base profiles.
profiles={
 'proportional':{'gpt-5.6-sol':[4,20],'gpt-5.6-terra':[10/6,10],'gpt-5.6-luna':[2,12],'gpt-6-astra':[15,75]},
 'output_only_previous_inputs':{'gpt-5.6-sol':[4,20],'gpt-5.6-terra':[1.6,10],'gpt-5.6-luna':[1.8,12],'gpt-6-astra':[15,75]},
 'output_only_standard_inputs':{'gpt-5.6-sol':[4,20],'gpt-5.6-terra':[2,10],'gpt-5.6-luna':[.2,12],'gpt-6-astra':[15,75]}}

def evaluate(rates):
 rows=[]
 for c in m.cycles[2:]:
  ss=m.select(c,'confirmed');es=sorted(c['events'],key=lambda e:e['timestamp']);ts=[];cost=[]
  for e in es:
   if e['model']=='codex-auto-review':continue
   if e['model'] not in rates:continue
   o=(e['base'][1]-.5*e['base'][0])/2;u=(e['base'][0]-20*o)/4
   assert u>=-1e-10 and o>=-1e-10
   ri,ro=rates[e['model']];cost.append((u*ri+o*ro)*(2.5 if e['fast'] is True else 1)*100/c['capacity']);ts.append(e['timestamp'])
  cs=np.r_[0,np.cumsum(cost)];base=cs[np.searchsorted(ts,c['start'],side='right')]
  a=cs[np.searchsorted(ts,[s['timestamp'] for s in ss],side='right')]-base;b=cs[np.searchsorted(ts,[s['confirmedAt'] for s in ss],side='right')]-base;y=np.array([s['percent'] for s in ss]);L=max(0,float(max(y-1-b)));U=float(min(y+1-a))
  h=max(0,float(max(a-y)),float((max(y-b)-min(y-a))/2))
  counts=collections.Counter(e['model'] for e in es if c['start']<e['timestamp']<=max(s['confirmedAt'] for s in ss))
  rows.append({'cycle':c['index'],'n':len(ss),'plan':c['plan'],'start':c['start'],'end':c['end'],'minimumHalfWidth':h,'at1Feasible':L<=U+1e-9,'initialIntervalAt1':[L,U],'modelCounts':dict(counts)})
 return {'ratesInputOutput':rates,'minimumHalfWidth':max(r['minimumHalfWidth'] for r in rows),'at1Feasible':all(r['at1Feasible'] for r in rows),'cycles':rows}

out={k:evaluate(v) for k,v in profiles.items()}
(m.P/'integer-output-prices.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
for k,v in out.items():
 print(k,'min width',v['minimumHalfWidth'],'failed cycles',[(r['cycle'],round(r['minimumHalfWidth'],6)) for r in v['cycles'] if not r['at1Feasible']]);print('sol cycle',v['cycles'][1])
