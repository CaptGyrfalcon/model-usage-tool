import json
from pathlib import Path
from datetime import datetime,timezone,timedelta
P=Path(__file__).resolve().parents[1]/'out/refit-500'
d=json.loads((P/'fit.json').read_text()); raw=json.loads((P/'data.json').read_text())
names={'free':'不计价','sol':'按 Sol 实际拟合价','parent':'按父模型实际拟合价'}
def dt(t):return datetime.fromtimestamp(t/1000,timezone(timedelta(hours=8))).strftime('%m-%d %H:%M') if t else '无'
s=['# Codex 本地费率复测（固定 $500 / $100）','','结论：能求出误差最小的参数，但无法确认一套跨全部周期成立的真实费率。标准价格结构下，按 Sol 计价的全样本误差最低；整周期留出验证则按父模型计价更优，排名不稳定。','','## 数据与方法','','- 数据库只读；Pro 5× 使用本地 prolite 标记，容量 $500；Plus $100。无套餐标记的早期观测不猜测归属。','- 11 个可用周期：6 Plus、5 Pro；511 个递增百分比观测，每周期首点作基线，得到 500 个累计变化约束，9067 条事件、624 条 auto-review。','- 每个周期从首个有效观测起算，截止该周期第一次生图工具调用前；没有生图则使用可用末点。前置调用没有可比水位，不参与回归。生图按 rollout 工具调用记录定位。','- fast=1 一律 2.5 倍；fast=0 或未标明均 1 倍。612 条 fast、1737 条未标明；不使用数据库已换算美元成本。','- auto-review 使用自身 fast 标记；第三种方案根据调用时间追溯父任务模型，共享该模型的拟合倍率。所有有用量的事件均可归属。','- 对各模型同时拟合非负倍率，Sol 不固定 1。输入／缓存／输出比值采用项目现有 standard.short 结构；本次不另加长上下文溢价。Spark 独立池排除。','- 最小化累计百分比变化的平方误差，每个新整数水位等权；首点差分避免假定周期此前用量完整。±1 点仅为取整相容性检验，不是统计置信区间。','', '## 全周期拟合','','| auto-review | Sol | Terra | Luna | Astra | RMSE（百分点） | 最大误差 | 超 ±1 点 | 留出周期 RMSE |','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
for k,v in d['scenarios'].items():
 s.append('|'+names[k]+'|'+'|'.join(f'{x:.4f}' for x in v['multiplier'].values())+f"|{v['rmse']:.3f}|{v['maxError']:.3f}|{v['outside1']}/500|{v['heldOutRMSE']:.3f}|")
s+=['','倍率基准（美元／百万 token，non-fast）：Sol 4 / 0.4 / 20；Terra 2 / 0.2 / 12；Luna 0.2 / 0.02 / 1.2；Astra 10 / 1 / 50。不是本次核实的官方订阅价格。','','## 最低训练误差方案的等效价格','','| 模型 | 输入 | 缓存输入 | 输出 |','|---|---:|---:|---:|']
for m,b in zip(d['models'],[(4,.4,20),(2,.2,12),(.2,.02,1.2),(10,1,50)]):
 x=d['scenarios']['sol']['multiplier'][m];s.append('|'+m+'|'+'|'.join(f'${z*x:.4f}' for z in b)+'|')
s+=['','以上是强行用一套价格解释所有周期的最小二乘解，不宜直接写成挂件的真实费率。Fast 将表内各列再乘 2.5。','','## 逐周期复测','','下表为各周期单独拟合 RMSE，非全局费率在该周期的误差；独立拟合参数详见 fit.json。','','| 观测起止（北京时间） | 套餐 | 观测数 | 首次生图 | 免费 | Sol 计价 | 父模型计价 |','|---|---|---:|---|---:|---:|---:|']
for i,c in enumerate(d['cycles']):
 s.append(f"|{dt(c['first']['timestamp'])}–{dt(c['last']['timestamp'])}|{c['plan']}|{c['observations']}|{dt(c['image'])}|"+'|'.join(f"{v['perCycle'][i]['local']['rmse']:.3f}" for v in d['scenarios'].values())+'|')
s+=['','## 稳定性与局限','','- 主要为 Sol 的 Plus 周期，按 Sol 计 auto-review 时独立倍率约 见 fit.json 各周期单独拟合值；固定周容量及 fast 假设下并不一致。','- 不计 auto-review、按 Sol、按父模型三种情形，即便改用最小化最坏误差，仍分别至少有 4.417、4.305、4.305 个百分点的偏差；不是换一个最小二乘解就能全部落入 ±1。','- 放开输入／缓存／输出，拟合 12 个独立非负价格后，最小最坏误差仍为 3.876、3.530、3.530 点；而部分价格压到 0，不能解释成实际免费。','- 仅 Pro 周期的最佳 RMSE 分别为 0.527、0.596、0.770 点；仍有 12、17、39 个约束超过 ±1。Terra 倍率落到 0 是辨识不足或模型失配，不是免费结论。','- 未记录 fast 依用户要求当作 non-fast，并不能证明这些历史调用实际都是 non-fast；此外日志完整性、额度更新延迟、历史计价变化、容量假设都可能造成差异，当前未能区分原因。','','## 与上次最后一个周期对照','','额外固定 Sol=1×，仅拟合 9 月 15 日至 9 月 17 日首次生图前，其余同本次口径；此附加锚点不用于全局结果。','','| auto-review | Astra | Luna | RMSE | 最大误差 |','|---|---:|---:|---:|---:|']
for k,v in d['scenarios'].items():
 a=v['latestSol1'];s.append(f"|{names[k]}|{a['multiplier']['gpt-6-astra']:.4f}|{a['multiplier']['gpt-5.6-luna']:.4f}|{a['rmse']:.3f}|{a['maxError']:.3f}|")
s+=['','三种都能在最近周期内落入 ±1 点，故不能据此识别 auto-review 的真实规则。此前 $480 和存储成本口径不应直接沿用。旧 rateCost 函数错误地再次扣除数据库里已经分离的缓存输入；本次已独立修正，并对普通调用与 auto-review 使用一致的正确 token 口径。','','复现：`node scripts/refit-codex-500-export.cjs`，再运行 `python scripts/refit-codex-500.py` 和 `python scripts/report-codex-500.py`。输出为本地数据推断，不是官方费率声明。']
(P/'report.md').write_text('\n'.join(s),encoding='utf-8')
print(P/'report.md')
