const VERSION = "codex-hypothesis-2026-09-27-v2";
const NOTE = "用户指定等效价格（美元/百万 tokens，输入/缓存命中/输出）：GPT-6 Astra 15/1.5/75、Sol 3/0.3/15、Luna 0.25/0.025/1.25；GPT-5.6 Sol 4.4/0.44/22、Terra 3.5/0.35/21、Luna 0.35/0.035/2.1。Fast：5.6 Terra/Luna 2×，其余上述模型 2.5×；未知按普通。缓存写入沿用输入价1.25×；自动审批每完整 turn $0.01。Pro5x每周$500，非官方账单。";
const RATES = {
  "gpt-5.6-sol": { input: 4.4, cacheRead: .44, cacheWrite: 5.5, output: 22 },
  "gpt-5.6-luna": { input: .35, cacheRead: .035, cacheWrite: .4375, output: 2.1 },
  "gpt-5.6-terra": { input: 3.5, cacheRead: .35, cacheWrite: 4.375, output: 21 },
  "gpt-6-astra": { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 },
  "gpt-6-sol": { input: 3, cacheRead: .3, cacheWrite: 3.75, output: 15 },
  "gpt-6-luna": { input: .25, cacheRead: .025, cacheWrite: .3125, output: 1.25 },
};
function fastMultiplier(key) {
  return key === "gpt-5.6-terra" || key === "gpt-5.6-luna" ? 2 : 2.5;
}
function model(key) {
  const rate = RATES[key];
  if (!rate) return null;
  const fast = Object.fromEntries(Object.entries(rate).map(([k,v]) => [k,v*fastMultiplier(key)]));
  return { provider: "openai", standard: { short: rate, long: rate }, fast: { short: fast, long: fast } };
}
function catalog(snapshot) {
  return { ...snapshot, note: `${NOTE} Cursor 仍使用官方价目表。`,
    modelsBySource: { ...snapshot?.modelsBySource, codex: {
      ...snapshot?.modelsBySource?.codex, ...Object.fromEntries(Object.keys(RATES).map(k=>[k,model(k)])),
    } } };
}
function capacity(plan, minutes) {
  if (minutes !== 10080) return null;
  return ({prolite:50000,pro5x:50000,plus:10000,pro:200000,pro20x:200000})[String(plan).toLowerCase()] ?? null;
}
function dollarQuota(total, used) {
  if (!(total > 0) || !Number.isFinite(used)) return null;
  used=Math.max(0,used);
  return {usedCents:used,inferredTotalCents:total,inferredTotalLowCents:total,inferredTotalHighCents:total,
    inferredRemainingCents:Math.max(0,total-used),packageTotalCents:total,packageTotalSource:"configured-dollar-capacity",
    percentUsed:used/total*100,percentRemaining:Math.max(0,100-used/total*100),estimateStatus:"local-dollar-usage"};
}
function cursorCapacity(plan) {
  const name=String(plan||"").toLowerCase().replace(/[\s_-]/g,"");
  return ({pro:45000,"pro+":120000,proplus:120000,ultra:300000})[name] ?? null;
}
function quota(window, plan, localCost) {
  const total = capacity(plan, window.windowMinutes);
  if (total == null || window.expired) return null;
  return { ...dollarQuota(total,localCost),
    localEstimatedCostCents: localCost,
    accountingVersion: VERSION };
}
module.exports = { VERSION, NOTE, RATES, fastMultiplier, model, catalog, capacity, quota, dollarQuota, cursorCapacity };
