// Read-only local/API diagnostic. Never print credentials or raw responses.
const { scanDevinUsage, fetchSubscription } = require("../src/devin.cjs");
const cache = new Map();
const history = { loadCache: key => cache.has(key) ? { value: cache.get(key) } : null,
  saveCache: (key, value) => cache.set(key, value), saveQuotaSample() {} };
(async () => {
  const scan = scanDevinUsage();
  const subscription = await fetchSubscription(history, { force: true });
  console.log(JSON.stringify({ files: scan.files, requests: scan.events.length, scanErrors: scan.scanErrors,
    subscription: { ok: subscription.ok, cached: subscription.cached, error: subscription.error,
      planName: subscription.planName, windowCount: subscription.quota?.windows.length,
      windows: subscription.quota?.windows.map(w => ({ name: w.name, resetKnown: w.resetsAt != null })),
      creditFields: Object.keys(subscription.credits || {}) } }, null, 2));
  if (scan.scanErrors.length || !subscription.ok) process.exitCode = 1;
})().catch(() => { console.error("Devin 检查失败"); process.exitCode = 1; });
