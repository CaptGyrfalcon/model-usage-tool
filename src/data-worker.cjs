const { parentPort } = require("node:worker_threads");
const { fetchSnapshot, getModelUsage, getTrendUsage, getQuotaTimeline, queryUsageEvents, getPricingCatalog } = require("./lib.cjs");
const { getHistory } = require("./history.cjs");
const { exportUsageEvents } = require("./event-export.cjs");
const { getVerification } = require("./codex-verification.cjs");

if (!parentPort) throw new Error("data-worker 必须由 worker_threads 启动");
// Sampling remains active even when the UI is hidden or its normal refresh is slow.
getVerification().tick().catch(() => {});
setInterval(() => getVerification().tick().catch(() => {}), 1000).unref();

parentPort.on("message", async ({ id, task, payload } = {}) => {
  try {
    let data;
    if (task === "verification") {
      const v=getVerification();
      if(payload?.action === "start") data=await v.start();
      else if(payload?.action === "stop") data=await v.stop();
      else if(payload?.action === "sample") data=await v.sample();
      else if(payload?.action === "export") {
        require("node:fs").writeFileSync(payload.filePath,JSON.stringify(v.export(getHistory()),null,2));
        data={filePath:payload.filePath};
      } else data=v.status();
    } else if (task === "fetch-snapshot") {
      data = await fetchSnapshot(payload || {});
    } else if (task === "get-receipt") {
      data = require("./receipt.cjs").getReceipt(getHistory(), payload);
    } else if (task === "get-model-usage") {
      data = getModelUsage(payload?.range);
    } else if (task === "get-trend-usage") {
      data = getTrendUsage(payload);
    } else if (task === "get-quota-timeline") {
      data = getQuotaTimeline(payload || {});
    } else if (task === "query-usage-events") {
      data = queryUsageEvents(payload || {});
    } else if (task === "get-pricing-catalog") {
      data = getPricingCatalog(payload || {});
    } else if (task === "export-usage-events") {
      data = exportUsageEvents(getHistory(), payload);
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
