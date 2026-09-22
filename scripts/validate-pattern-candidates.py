import importlib.util,json
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
spec=importlib.util.spec_from_file_location('s',Path(__file__).with_name('search-pattern-neat.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
g=s.g
def capacity(bb,x):
 n=1+len(bb);rows=[];rhs=[]
 for k,(c,ss,lo,hi) in enumerate(bb):
  for sample,a,b in zip(ss,lo,hi):
   p=sample['percent'];row=np.zeros(n);row[0]=-(p+1);row[k+1]=1
   if p<100:rows.append(row);rhs.append(-a@x)
   row=np.zeros(n);row[0]=p-1;row[k+1]=-1;rows.append(row);rhs.append(b@x)
 ob=np.zeros(n);ob[0]=1;kw=dict(A_ub=rows,b_ub=rhs,bounds=[(0,None)]*n,method='highs')
 a=linprog(ob,**kw);b=linprog(-ob,**kw)
 return {'plus':[100*a.x[0],100*b.x[0]],'pro5x':[500*a.x[0],500*b.x[0]]} if a.success and b.success else None
results=[]
for label,astra in [('simple72',[14.4,1.44,72]),('separate100',[5,1.65,100])]:
 x=g.baseline.copy();x[9:12]=astra
 for lag in [0,60,120,180,300]:
  for kind in ['confirmed','crossing','raw']:
   bb=g.blocks(lag,kind);h,per=s.score(bb,x)
   results.append({'label':label,'astra':astra,'lag':lag,'kind':kind,'halfWidth':h,'perCycle':per,'capacityRangeAt1':capacity(bb,x)})
validation=[]
for lag in [60,180]:
 for leave in range(2,11):
  bb=g.blocks(lag,ids=[i for i in range(2,11) if i!=leave]);fixed={j:float(v) for j,v in enumerate(g.baseline) if j not in [9,10,11]}
  r=g.f.fit(bb,fixed);x=np.array(list(r['rates'].values()));h,per=s.score(g.blocks(lag,ids=[leave]),x)
  validation.append({'lag':lag,'leftOut':leave,'astra':x[9:12].tolist(),'trainingHalfWidth':r['halfWidth'],'heldOutHalfWidth':h})
(g.f.OUT/'validation.json').write_text(json.dumps({'candidates':results,'leaveOneCycleOut':validation},indent=2))
print(json.dumps([r for r in results if r['kind']=='confirmed' and r['lag'] in [60,180]],indent=2))
print(json.dumps(validation))
