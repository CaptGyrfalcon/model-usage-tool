import importlib.util,json,itertools
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('g',Path(__file__).with_name('fit-pattern-components.py'))
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)

def score(bb,x):
 vals=[]
 for c,ss,lo,hi in bb:
  y=np.array([s['percent'] for s in ss]);lower=max(y-hi@x);upper=min((y-lo@x)[y<100])
  h=max(0,(lower-upper)/2,-upper);b=max(0,(lower+upper)/2)
  vals.append({'cycle':c['index'],'halfWidth':float(h),'balance':float(b)})
 return max(v['halfWidth'] for v in vals),vals

if __name__=='__main__':
 results=[]
 # Only Astra components change; all other prices and both fees fixed.
 for lag in [0,60,120,180,300]:
  bb=g.blocks(lag);candidates=[]
  for inp,cache,out in itertools.product([3,3.5,4,5,7.5,10,12.5,15],[1.4,1.5,1.6,1.65,1.7,1.75,1.8],range(60,106,5)):
   x=g.baseline.copy();x[9:12]=[inp,cache,out];h,per=score(bb,x)
   candidates.append({'lag':lag,'astra':[inp,cache,out],'halfWidth':h,'perCycle':per})
  candidates.sort(key=lambda r:r['halfWidth']);results.extend(candidates[:10])
  print(json.dumps(candidates[0]))
 # Specific simple candidates and sensitivity to the sample selector.
 checks=[]
 for kind in ['confirmed','crossing','raw']:
  for lag in [0,60,120,180,300]:
   bb=g.blocks(lag,kind)
   for astra in [[14.4,1.44,72],[5,1.6,95],[5,1.65,90],[5,1.65,95],[10,1.5,90],[15,1.5,75]]:
    x=g.baseline.copy();x[9:12]=astra;h,per=score(bb,x)
    checks.append({'kind':kind,'lag':lag,'astra':astra,'halfWidth':h,'perCycle':per})
 (g.f.OUT/'neat.json').write_text(json.dumps({'search':results,'checks':checks},indent=2))
