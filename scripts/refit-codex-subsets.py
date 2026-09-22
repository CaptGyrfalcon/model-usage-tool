"""Enumerate all Plus exclusions, retain every Pro cycle; LP interval feasibility."""
import ast,json,itertools
from datetime import datetime,timezone,timedelta
from pathlib import Path
import numpy as np
from scipy.optimize import linprog,nnls
P=Path(__file__).resolve().parents[1]/'out/refit-500'
data=json.loads((P/'data.json').read_text());models=data['models'];cycles=data['cycles']
# Reuse pure functions without executing the previous report-generation entrypoint.
tree=ast.parse((Path(__file__).with_name('refit-codex-500.py')).read_text())
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]),'<fit-functions>','exec'))
blocks={mode:[matrix(c,mode) for c in cycles] for mode in ['free','sol','parent']}

def solve(mode,ids,rounding='symmetric',fixed=None):
    # x=4 shared model multipliers + independent first-observation offsets + h.
    # h is total symmetric half width, or extra error around exact rounding bins.
    width=blocks[mode][0][0].shape[1]
    n=width+len(ids)+1; rows=[];rhs=[]
    for j,i in enumerate(ids):
        A,y=blocks[mode][i]; A=np.vstack([np.zeros(width),A]);y=np.r_[0,y]
        first=cycles[i]['samples'][0]['percent']
        for a,b in zip(A,y):
            p=first+b; vec=np.zeros(n);vec[:width]=a;vec[width+j]=1
            lo,hi={'symmetric':(0,0),'nearest':(-.5,.5),'floor':(0,1),'ceil':(-1,0)}[rounding]
            if p<100:
                r=vec.copy();r[-1]=-1;rows.append(r);rhs.append(b+hi)
            r=-vec;r[-1]=-1;rows.append(r);rhs.append(-b-lo)
            # Underlying consumption at the initial observation cannot be negative.
            if p==first and b==0:
                r=-vec;r[-1]=0;rows.append(r);rhs.append(first)
    bounds=[(0,None)]*width+[(None,None)]*len(ids)+[(0,None) if fixed is None else (fixed,fixed)]
    objective=np.zeros(n);objective[-1]=1
    result=linprog(objective,A_ub=rows,b_ub=rhs,bounds=bounds,method='highs')
    if not result.success:return {'feasible':False}
    x=result.x[:width]; offsets=result.x[width:-1];h=result.x[-1]
    residual=[]; centered=[]
    for i,o in zip(ids,offsets):
        A,y=blocks[mode][i];residual.extend(A@x+o-y);centered.extend(A@x-y)
    labels=models if width==4 else [m+':'+t for m in models for t in ['input','cache','output']]
    return {'feasible':True,'halfWidthOrExtra':float(h),'multiplier':dict(zip(labels,x)),'offsets':dict(zip(map(str,ids),offsets)),
        'rmse':float(np.sqrt(np.mean(np.array(residual)**2))),'maxAbsResidual':float(max(abs(np.array(residual)))),
        'baselineDifferenceMaxError':float(max(abs(np.array(centered))))}

out={'cycleLabels':[{'index':i,'plan':c['plan'],'first':c['samples'][0]['timestamp'],'last':c['samples'][-1]['timestamp']} for i,c in enumerate(cycles)],'scenarios':{}}
for mode in blocks:
    subsets=[]
    for mask in range(64):
        kept=[i for i in range(6) if mask&(1<<i)];ids=kept+list(range(6,11))
        r=solve(mode,ids);r.update(keptPlus=kept,removedPlus=[i for i in range(6) if i not in kept]);subsets.append(r)
    best=[min((s for s in subsets if len(s['removedPlus'])==n),key=lambda s:s['halfWidthOrExtra']) for n in range(7)]
    individual=[solve(mode,[i]) for i in range(11)]
    kept=[i for i in range(11) if i not in [0,1]]
    comparison=fit([blocks[mode][i] for i in kept])
    out['scenarios'][mode]={'dropFirstTwoOLS':comparison,'dropFirstTwo':solve(mode,kept),'bestByRemovedCount':best,'individual':individual,'allProRounding':{r:solve(mode,list(range(6,11)),r) for r in ['nearest','floor','ceil']},'allSubsets':subsets}
    print(mode,[(len(r['removedPlus']),r['removedPlus'],round(r['halfWidthOrExtra'],4)) for r in best])
    print('individual widths',[round(r['halfWidthOrExtra'],4) for r in individual])
out['independentTokenPrices']={}
for mode in ['free','sol','parent']:
    old=blocks[mode];expanded=[]
    for c in cycles:
        total=np.zeros(12);rows=[];j=0
        for s in c['samples']:
            while j<len(c['events']) and c['events'][j]['timestamp']<=s['timestamp']:
                e=c['events'][j];j+=1;m=e['model']
                if m=='codex-auto-review':
                    if mode=='free':continue
                    m=models[0] if mode=='sol' else e['parent']
                if m not in models:continue
                k=models.index(m)*3
                total[k:k+3]+=np.array([e['input_tokens'],e['cache_read_tokens'],e['output_tokens']])*e['factor']*100/c['capacity']/1e6
            rows.append(total.copy())
        expanded.append((np.array(rows[1:]),np.array([s['percent']-c['samples'][0]['percent'] for s in c['samples'][1:]])))
    blocks[mode]=expanded
    out['independentTokenPrices'][mode]={'proOnly':solve(mode,list(range(6,11))),'dropFirstTwo':solve(mode,list(range(2,11))),'problemPro':solve(mode,[7])}
    print('independent tokens',mode,{k:round(v['halfWidthOrExtra'],4) for k,v in out['independentTokenPrices'][mode].items()})
    blocks[mode]=old
(P/'subsets.json').write_text(json.dumps(out,indent=2),encoding='utf-8')

# Independent feasibility checks at h=1, and at the reported optimum.
for mode in ['free','sol','parent']:
    assert not solve(mode,list(range(6,11)),fixed=1)['feasible']
    best=out['scenarios'][mode]['bestByRemovedCount'][-1]
    assert solve(mode,list(range(6,11)),fixed=best['halfWidthOrExtra']+1e-7)['feasible']
    assert not solve(mode,list(range(6,11)),fixed=best['halfWidthOrExtra']-1e-4)['feasible']
print('PASS: direct LP infeasibility at +/-1 and optimum boundary checks')

def date(t):return datetime.fromtimestamp(t/1000,timezone(timedelta(hours=8))).strftime('%m-%d %H:%M')
labels={'free':'免费','sol':'Sol 实际价','parent':'父模型实际价'}
lines=['# 剔除 Plus 周期后的费率与额度交集复测','','沿用上次冻结的数据快照、修正后的 token 口径、$500/$100 周容量、fast=2.5、未标明 fast=1，并保留全部 5 个 Pro 周期。','','## 结论','','只剔除 Plus 周期不足以让观测区间交集非空。穷举 6 个 Plus 周期的 64 种保留组合，三种 auto-review 方案均不能满足每个观测 ±1 个百分点的宽松包络。正常四舍五入的 ±0.5 点以及 floor/ceil 的宽度 1 点区间更严格，也均不可行。','','## 方法与交集含义','','不把每周期首个整数水位当成精确值：为它保留一个共享的未知初始用量 B。每个观测满足：','','`(p_j-h) Q / 100 ≤ B + D_j(模型费率) ≤ (p_j+h) Q / 100`','','其中 Q 为固定周容量，D 为首点之后累计成本，B≥0；所有观测共用该周期同一个 B，所有周期共用一套模型费率。0% 下界裁到零，100% 上界允许饱和。线性规划求最小 h，并直接检查 h=1 的可行性。这等价于联合检查额度/初始用量区间相容性，比仅计算平均误差或分别检查百分比差更严格。','','输入、缓存、输出先共享各模型同一倍率；又用 12 个独立非负 token 价格做了放宽检验。未人为限定倍率接近整数，也未固定 Sol=1。','','## 最明显的两个 Plus 周期','','两者在三种方案下，单独拟合也无法满足 ±1 点：']
for i in [0,1]:
 c=cycles[i];lines.append(f"- 周期 {i}：{date(c['samples'][0]['timestamp'])}—{date(c['samples'][-1]['timestamp'])}；所需最小 h（免费／Sol／父模型）："+' / '.join(f"{out['scenarios'][m]['individual'][i]['halfWidthOrExtra']:.3f}" for m in labels)+' 点。')
lines+=['','## 剔除这两个周期：保留 4 Plus + 5 Pro','','OLS 一栏沿用上次的首点差分累计误差定义；最后一栏为另行优化的观测区间半宽，两者不是同一个目标函数。','','| auto-review | OLS RMSE | OLS 最大误差 | OLS 超 ±1 点 | 交集非空所需最小 h |','|---|---:|---:|---:|---:|']
for m,v in out['scenarios'].items():
 a=v['dropFirstTwoOLS'];b=v['dropFirstTwo'];lines.append(f"|{labels[m]}|{a['rmse']:.3f}|{a['maxError']:.3f}|{a['outside1']}/{a['n']}|±{b['halfWidthOrExtra']:.3f}|")
lines+=['','## 穷举所有 Plus 子集','','每行允许挑选最有利的剔除组合，因此属于乐观下界，不能视为预先独立识别异常后的验证。','','| 剔除 Plus 数 | 免费最小 h | Sol 最小 h | 父模型最小 h |','|---|---:|---:|---:|']
for k in range(7):lines.append(f'|{k}|'+ '|'.join(f"{out['scenarios'][m]['bestByRemovedCount'][k]['halfWidthOrExtra']:.3f}" for m in labels)+'|')
lines+=['','## Pro 内部仍有冲突','','尤其周期 7：'+date(cycles[7]['samples'][0]['timestamp'])+'—'+date(cycles[7]['samples'][-1]['timestamp'])+'，即首次生图之前的 39 个观测。保持模型标准价格比例时，该周期单独也至少需要约 ±1.331／±1.331／±1.342 点。','','即使完全放开 12 个输入／缓存／输出价格，只保留 5 个 Pro，最小 h 仍为：'+ ' / '.join(f"{out['independentTokenPrices'][m]['proOnly']['halfWidthOrExtra']:.3f}" for m in labels)+' 点（三种方案顺序同上）。仍不能靠更自由的价格结构让 ±1 点的交集非空。','','## 如何解释','','- 若允许额外观测误差，可以得到非空可行域：剔除上述两个 Plus，最宽松的父模型方案需要约 ±1.9374 点；实际留余量可用 ±1.94 点。','- 若仅接受整数取整造成的误差，目前没有满足要求的统一费率。误差减小并不等于额度范围已经有交集。','- 这些周期只是对当前计价模型不相容，尚不能断言日志错误；缺失 fast 标记、额度更新延迟、历史费率变化、容量假设均可能造成矛盾。','- 本次仅沿用上次各整数水位第一次上升的观测子集；该子集已不可行，增加相同周期的其他观测也不会恢复可行性。','','参数、各周期初始偏移、64 种组合均保存在 subsets.json。复现：`python scripts/refit-codex-subsets.py`。']
(P/'subset-report.md').write_text('\n'.join(lines),encoding='utf-8')
