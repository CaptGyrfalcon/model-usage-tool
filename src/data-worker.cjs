const { parentPort } = require("node:worker_threads");
const { fetchSnapshot, getModelUsage, getQuotaTimeline, queryUsageEvents, getPricingCatalog } = require("./lib.cjs");

if (!parentPort) throw new Error("data-worker 必须由 worker_threads 启动");

parentPort.on("message", async ({ id, task, payload } = {}) => {
  try {
    let data;
    if (task === "fetch-snapshot") {
      data = await fetchSnapshot(payload || {});
    } else if (task === "get-model-usage") {
      data = getModelUsage(payload?.range);
    } else if (task === "get-quota-timeline") {
      data = getQuotaTimeline(payload || {});
    } else if (task === "query-usage-events") {
      data = queryUsageEvents(payload || {});
    } else if (task === "get-pricing-catalog") {
      data = getPricingCatalog(payload || {});
    } else if (task === "health") {
      data = { ready: true };
    } else {
      throw new Error(`未知后台任务：${task || "(空)"}`);
    }
    parentPort.postMessage({ id, ok: true, data });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || null,
    });
  }
});
