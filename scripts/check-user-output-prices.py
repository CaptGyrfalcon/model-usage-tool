"""Fixed proposed rates; no price coefficient is fitted."""
import contextlib,io,runpy,json
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
with contextlib.redirect_stdout(io.StringIO()):
 ctx=runpy.run_path(str(Path(__file__).with_name('fit-review-per-turn.py')))
f=ctx['f'];f.block=ctx['make_block']('complete',False)
x=np.array([1,1,5/3,1.5,0,0,.01])

def capacity(ids,lag,h):
 bs=[f.block(c,lag=lag) for c in f.m.cycles if c['index'] in ids];n=len(bs)+1;rows=[];rhs=[]
 for k,b in enumerate(bs):
  for a,z,y in zip(b['A']@x,b['B']@x,b['y']):
   row=np.zeros(n);row[0]=-(y+h);row[k+1]=1
   if y<100:rows.append(row);rhs.append(-a)
   row=np.zeros(n);row[0]=y-h;row[k+1]=-1;rows.append(row);rhs.append(z)
 kw=dict(A_ub=rows,b_ub=rhs,bounds=[(0,None)]*n,method='highs');obj=np.zeros(n);obj[0]=1
 lo=linprog(obj,**kw);hi=linprog(-obj,**kw)
 return [float(lo.x[0]),float(hi.x[0])] if lo.success and hi.success else None

results=[]
for lag in [0,30,60,120,300]:
 r=f.fit('count','all_free',coef=x,lag=lag)
 r['capacityIntervalsAt1']={name:capacity(ids,lag,1) for name,ids in [('common',range(2,11)),('plus',range(2,6)),('pro',range(6,11))]}
 results.append(r);print('lag',lag,'h',r['halfWidth'],'cap',r['capacityIntervalsAt1'],flush=True)
others=[{'group':name,**f.fit('count','all_free',coef=x,lag=0,ids=ids,kind=kind)} for name,ids,kind in [('all11',range(11),'confirmed'),('crossings9',range(2,11),'crossing')]]
# Minimum additional symmetric timestamp allowance for fixed100/500 at ±1.
lo,hi=0.,300.
for _ in range(25):
 mid=(lo+hi)/2
 if f.fit('count','all_free',coef=x,lag=mid)['halfWidth']<=1:hi=mid
 else:lo=mid
pure=json.loads((f.m.P.parent/'luna-isolation/analysis.json').read_text())
pc=pure['fullPercent']['lunaBaseUSD']*5/3
out={'rates':{'sol':[4,.4,20],'terra':[2,.2,12],'luna':[1/3,1/30,2],'astra':[15,1.5,75],'reviewPerTurn':.01},'results':results,'otherSamples':others,'minimumExtraSecondsForAt1':hi,'newPureLuna':{'baseUSD':pure['fullPercent']['lunaBaseUSD'],'proposedUSD':pc,'predictedPercentagePointsAt500':pc/5,'gapFrom5USD':pc-5}}
(f.m.P/'user-output-prices.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
lines=['# 用户指定输出价格回测','',
'固定输入/缓存/输出价（美元/百万token）：Sol4/0.4/20，Terra2/0.2/12，Luna1/3、1/30、2，Astra15/1.5/75。Review每完整turn固定0.01美元，不再按token或父模型计价。主模型fast2.5倍，未知non-fast。', '',
'保留此前9周期、228个确认观测，截止生图前；不重新选样本。固定Plus100/Pro5x500，仅每周期初始已用余额可拟合且非负。原有时间区间为首次观测至另一会话确认；额外时间容差向前后各扩展。','',
'| 额外时间容差 | 最小百分点容差 | ±1时共同容量比例区间 |','|---|---:|---|']
for r in results:lines.append(f"| ±{r['lag']}秒 | ±{r['halfWidth']:.6f} | {r['capacityIntervalsAt1']['common']} |")
lines+=['',f'固定100/500使容差达到±1所需的最小额外对称时间放宽约{hi:.3f}秒；这是样本内阈值，不是实测延迟。','',
'共同容量比例区间乘100/500即对应Plus/Pro5x范围。这是可行投影，不是统计置信区间。','',
'## 不额外放宽时间的逐周期结果','', '| 周期索引 | 点数 | 最小所需容差 |','|---|---:|---:|']
for c in results[0]['cycles']:lines.append(f"| {c['cycle']} | {c['n']} | ±{c['maxIntervalError']:.6f} |")
lines+=['', '逐周期误差使用全局LP所给初始余额，不应据此称每周期各自最优；下方JSON保留构造解。','',
f"纯Luna新样本：原价成本${pure['fullPercent']['lunaBaseUSD']:.8f}，新价成本${pc:.8f}，在500容量下预测消耗{pc/5:.6f}个百分点。实际显示跨越1个百分点，差{(pc/5-1):.6f}个百分点。该样本参与了提出价格假设，不能称完全独立盲测。",'',
'不能用此结果确认后台收费：±1容差大于单次四舍五入通常范围，延迟未测定，review计费未验证，主动查询与会话缓存余额的口径仍不同。']
(f.m.P/'user-output-prices-report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('minimum extra seconds',hi,'pure proposed dollars',pc,'others',[(r['group'],r['halfWidth']) for r in others])
