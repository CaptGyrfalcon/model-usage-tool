const VERSION = "codex-hypothesis-2026-09-18-v1";
const NOTE = "假设价格：Sol 20 / Luna 2 / Terra 12 / Astra 75 美元每百万输出 token；输入与缓存同比例；Fast 2.5×，未知按普通；自动审批每完整 turn $0.01。非官方账单。";
const RATES = {
  "gpt-5.6-sol": { input: 4, cacheRead: .4, cacheWrite: 5, output: 20 },
  "gpt-5.6-luna": { input: 1/3, cacheRead: 1/30, cacheWrite: 5/12, output: 2 },
  "gpt-5.6-terra": { input: 2, cacheRead: .2, cacheWrite: 2.5, output: 12 },
  "gpt-6-astra": { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 },
};
function model(key) {
  const rate = RATES[key];
  if (!rate) return null;
  const fast = Object.fromEntries(Object.entries(rate).map(([k,v]) => [k,v*2.5]));
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
module.exports = { VERSION, NOTE, RATES, model, catalog, capacity, quota, dollarQuota, cursorCapacity };
