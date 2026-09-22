import importlib.util,json,itertools
from pathlib import Path
import numpy as np
from scipy.optimize import linprog
s=importlib.util.spec_from_file_location('f',Path(__file__).with_name('fit-independent-review.py'));f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
bs=[f.block(c) for c in f.m.cycles[2:]]
def width(x):
 return max(max(0,float(max(b['A']@x-b['y'])),float((max(b['y']-b['B']@x)-min(b['y']-b['A']@x))/2)) for b in bs)
grid=[]
for t,l,a,r in itertools.product(np.arange(.70,1.001,.01),np.arange(5.5,9.51,.5),[1.48,1.49,1.50,1.51],[.20,.25,.30,.35,.40,.45,.50]):
 x=np.array([1,t,l,a,4*r,20*r,0]);h=width(x)
 if h<=1+1e-9:grid.append({'coefficients':np.round(x,9).tolist(),'halfWidth':h})
grid.sort(key=lambda z:(abs(z['coefficients'][3]-1.5),abs(z['coefficients'][4]-1),abs(z['coefficients'][1]-round(z['coefficients'][1],1)),z['halfWidth']))
print('neat',len(grid),grid[:12])
def capacity(x,ids):
 selected=[b for b in bs if b['cycle'] in ids];n=1+len(selected);rows=[];rhs=[]
 for k,b in enumerate(selected):
  for lo,hi,y in zip(b['A']@x,b['B']@x,b['y']):
   row=np.zeros(n);row[0]=-(y+1);row[k+1]=1
   if y<100:rows.append(row);rhs.append(-lo)
   row=np.zeros(n);row[0]=y-1;row[k+1]=-1;rows.append(row);rhs.append(hi)
 kw=dict(A_ub=rows,b_ub=rhs,bounds=[(0,None)]*n,method='highs');obj=np.zeros(n);obj[0]=1
 lo=linprog(obj,**kw);hi=linprog(-obj,**kw)
 return [lo.x[0],hi.x[0]] if lo.success and hi.success else None
x=np.array([1,10/12,10/1.2,1.5,1,5,0])
best={'coefficients':x.tolist(),'halfWidth':width(x),'selection':'Terra and Luna output10; review1/0.1/5'}
witness=f.fit(coef=x,h=1)
caps={k:capacity(x,ids) for k,ids in [('common',range(2,11)),('plus',range(2,6)),('pro',range(6,11))]}
o={'grid':grid,'chosen':best,'witnessAt1':witness,'capacityScaleIntervalsAt1':caps}
(f.m.P/'independent-review-neat.json').write_text(json.dumps(o,indent=2),encoding='utf-8')
print('capacity',caps,'witness',witness['success'])
raw=json.loads((f.m.P/'independent-review.json').read_text())
lines=['# Auto-review 独立固定费率回测','',
'使用纠正 fork 归属后的 Codex 原始日志导出，剔除原先指定的两个 Plus 周期，保留 4 个 Plus 和 5 个 Pro5x 周期。全部截止各周期首次生图调用前。228 个跨会话确认观测；使用首次观测到确认观测之间的时间区间，不额外放宽时延。Plus100、Pro5x500；明确 fast 按2.5倍，其余按non-fast。每周期拟合非负初始已用额度。', '',
'费率均为假设容量下的等效美元价格，不是已确认的官方实际账单。独立 token 费率对所有父模型相同；缓存输入价固定为普通输入的10%。原始导出的四种基础成本只能恢复 input+0.1*cache 和 output，不能独立识别缓存价。按次模型实际使用 usage-event 数量作为代理，不能据此声称是每次完整审查的扣费。','',
'## 拟合结果','', '| 主模型约束 | Review 模型 | 最小容差（百分点） |','|---|---|---:|']
for r in raw['results']:
 lines.append(f"| {r['main']} | {r['review']} | ±{r['halfWidth']:.6f} |")
lines+=['','sol_fixed 表示 Sol=1、其余三个倍率自由；rounded 表示1/0.8/9/1.5；integer_outputs 表示1/(10/12)/10/1.5，即Terra输出10、Luna输出12，输入同比例调整；all_standard为全部1；all_free为四者均可调整。sol_shape为review输入:缓存:输出=4:0.4:20，仅整体倍率自由；tokens为输入、输出价独立非负；count为每usage事件固定费用。','',
'## 可复核的取整价格','',f"选定系数：{best['coefficients']}；最小容差 ±{best['halfWidth']:.6f} 个百分点。",'',
'| 模型 | 输入 $/百万 | 缓存 $/百万 | 输出 $/百万 |','|---|---:|---:|---:|']
for name,base,j in [('Sol',[4,.4,20],0),('Terra',[2,.2,12],1),('Luna',[.2,.02,1.2],2),('Astra',[10,1,50],3)]:
 p=np.array(base)*x[j];lines.append(f'| {name} | {p[0]:.6g} | {p[1]:.6g} | {p[2]:.6g} |')
lines.append(f'| Auto-review | {x[4]:.6g} | {x[4]/10:.6g} | {x[5]:.6g} |')
lines+=['',f"固定价格、各周期初始余额可调整，±1百分点下共同容量比例区间：{caps['common']}。乘100/500得到Plus/Pro5x容量；该区间包含1，故100/500可同时成立。不是统计置信区间。",'',
'## 局限与稳定性','',
'- 严格±0.5百分点不相容；±1容差比单次整数百分比的通常四舍五入范围宽。',
'- 取整候选来自网格搜索，属于样本内挑选；不能当作独立验证。',
'- 保留所有11周期、或使用未跨会话确认的全部373个递增观测，独立review模型仍不能在±1内相容。',
'- 自由调整Sol时，最小最大误差解把review价格取到0，并把Sol提高至约1.015；当前数据不能排除“Sol稍贵、review免费”这个竞争解释。',
'- review输入/输出独立拟合把输出价格推到0边界，反映参数难以独立识别，不证明真实输出免费。',
'- Radar的1919/1145未作为拟合数据，其统计定义和工作负载未知，不能用2000减它们来直接验证review花费。','',
'留一周期验证：其余8周期拟合共同价格，只允许被留出的周期调整自己的初始余额。以下最坏容差体现外推风险，也会受到训练集多解的影响。','',
'| Review 模型（Sol=1） | 最坏留出周期容差 | 平均留出周期容差 |','|---|---:|---:|']
for r in raw['leaveOneCycleOut']:lines.append(f"| {r['review']} | ±{r['maxHeldHalfWidth']:.3f} | ±{r['meanHeldHalfWidth']:.3f} |")
lines+=['','完整结果：independent-review.json；取整价格、逐周期构造性证据和容量区间：independent-review-neat.json。']
(f.m.P/'independent-review-report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
