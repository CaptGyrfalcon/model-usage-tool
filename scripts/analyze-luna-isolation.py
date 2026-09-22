import json,collections,datetime
from pathlib import Path
P=Path(__file__).resolve().parents[1]/'out/luna-isolation'
d=json.loads((P/'raw.json').read_text());es=sorted(d['events'],key=lambda x:x['timestamp'])
ss=sorted([s for s in d['samples'] if s['quality']=='valid' and s['windowMinutes']==10080 and s['planType']=='prolite'],key=lambda x:x['timestamp'])
fmt=lambda t:datetime.datetime.fromtimestamp(t/1000,datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec='milliseconds')
cross={p:next(s for s in ss if s['usedPercent']==p) for p in [76,77,78]}
start=max(e['timestamp'] for e in es if e['model']!='gpt-5.6-luna' and e['timestamp']<cross[77]['timestamp'])
end=min(e['timestamp'] for e in es if e['model']!='gpt-5.6-luna' and e['timestamp']>cross[78]['timestamp'])
def stats(a,b):
 ev=[e for e in es if a<e['timestamp']<=b];lv=[e for e in ev if e['model']=='gpt-5.6-luna'];tok={k:sum(e[k] for e in lv) for k in ['input','cacheRead','cacheWrite','output']}
 cost=(tok['input']*.2+tok['cacheRead']*.02+tok['output']*1.2)/1e6
 return {'start':fmt(a),'end':fmt(b),'models':dict(collections.Counter(e['model'] for e in ev)),'lunaTokens':tok,'lunaBaseUSD':cost,'fast':sum(e['fast'] for e in lv),'unknownFast':sum(not e['fastKnown'] for e in lv),'sessions':len({e['eventKey'].split(':')[2] for e in lv})}
a=cross[77]['timestamp'];b=cross[78]['timestamp'];exact=stats(a,b)
checks=[]
for sid in {e['eventKey'].split(':')[2] for e in es if a<e['timestamp']<=b}:
 vs=[e for e in es if e['eventKey'].split(':')[2]==sid and e['timestamp']<=b];pre=[e for e in vs if e['timestamp']<=a];cur=[e for e in vs if e['timestamp']>a]
 def tokens(e):
  v=list(map(int,e['eventKey'].split(':')[3:]));return [v[0]-v[1],v[1],v[2]]
 old=tokens(pre[-1]) if pre else [0,0,0];delta=[u-v for u,v in zip(tokens(cur[-1]),old)];sums=[sum(e[k] for e in cur) for k in ['input','cacheRead','output']]
 assert delta==sums,(sid,delta,sums)
 checks.append(sid)
brackets={}
for p in [77,78]:
 s=cross[p];old=max((v for v in ss if v['sessionId']==s['sessionId'] and v['origin']==s['origin'] and v['timestamp']<s['timestamp'] and v['usedPercent']==p-1),key=lambda v:v['timestamp'])
 brackets[p]=[old['timestamp'],s['timestamp']]
sample_range=[stats(brackets[77][1],brackets[78][0])['lunaBaseUSD'],stats(brackets[77][0],brackets[78][1])['lunaBaseUSD']]
timing_range=[stats(a+60000,b-60000)['lunaBaseUSD'],stats(a-60000,b+60000)['lunaBaseUSD']]
out={'crossings':{p:{'time':fmt(s['timestamp']),'origin':s['origin'],'path':s['originPath'],'line':s['recordIndex'],'session':s['sessionId']} for p,s in cross.items()},'pureStart':fmt(start),'nextOtherModel':fmt(end),'partialFirstPercent':stats(start,a),'fullPercent':exact,'pureTotal':stats(start,end-1),'sameStreamBoundaryBrackets':{p:list(map(fmt,v)) for p,v in brackets.items()},'samplingCostRange':sample_range,'extra60secSensitivityRange':timing_range,'cumulativeCheckedSessions':len(checks),'impliedMultiplierAssuming500':5/exact['lunaBaseUSD'],'impliedCapacityAssuming1x':100*exact['lunaBaseUSD']}
(P/'analysis.json').write_text(json.dumps(out,indent=2),encoding='utf-8');print(json.dumps(out,indent=2))
lines=['# 纯 Luna 区间与周额度跳变','',
'仅使用纠正fork归属后的Codex原始日志扫描，未读取挂件数据库。时间均北京时间。Luna基准输入/缓存/输出单价为每百万token $0.2/$0.02/$1.2；未知fast按non-fast。','',
f"最后一条此前其他模型事件：{fmt(start)}；下一条其他模型事件：{fmt(end)}。后者为本次分析的Astra调用。",'',
'| 剩余额度 | 首次观测时间 |','|---|---|']
for p in [76,77,78]:lines.append(f"| {100-p}% | {fmt(cross[p]['timestamp'])} |")
lines+=['',f"完整23%→22%区间：{exact['models']}，涉及{exact['sessions']}个会话。Luna原价成本${exact['lunaBaseUSD']:.8f}。",'',
f"token：{exact['lunaTokens']}。{len(checks)}个会话的逐条增量加总与原始累计token差全部相等。已知fast {exact['fast']}条；未知fast {exact['unknownFast']}条，按约定计non-fast。",'',
f"同会话跳变前后观测夹出的成本范围：${sample_range[0]:.8f}～${sample_range[1]:.8f}。这只包含采样边界的不确定性，不包含服务器延迟或跨会话在途请求。额外±60秒敏感性范围：${timing_range[0]:.8f}～${timing_range[1]:.8f}，也不是统计置信区间。",'',
f"24%→23%的纯Luna后半段成本${out['partialFirstPercent']['lunaBaseUSD']:.8f}，但24%首次出现时仍在运行Astra，不能把该后半段当作完整1个百分点，也不能把纯Luna总成本除以2。",'',
f"条件推断：若每周容量500且该跳变间隔近似代表真实1个百分点，Luna约{out['impliedMultiplierAssuming500']:.4f}倍；若Luna严格原价，则对应容量约${out['impliedCapacityAssuming1x']:.2f}。单个间隔不能同时识别费率与容量。",'',
'原始78→77→78回退出现在不同会话间，计算使用首次向上跨越阈值，未重复计数。尚未证明日志之外无共享额度消耗，也未确认未知请求实际服务档位。']
(P/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
