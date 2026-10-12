const ReceiptModel = require("./renderer/receipt-model.js");
// Read a local calendar period from one SQLite snapshot; never reprice history.
function dayBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("请选择有效日期");
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error("日期无效");
  return { start: +start, end: +new Date(year, month - 1, day + 1) };
}

function getReceipt(history, { date, source = "all", period = "day", ...options } = {}) {
  const { start, end } = ReceiptModel.range(date, period);
  if (!["all", "cursor", "codex", "claude", "deepseek", "devin"].includes(source)) throw new Error("数据来源无效");
  const rows = history.db.prepare(`SELECT source, model, effort, fast,
    SUM(request_count) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
    SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
    SUM(equivalent_cost_cents) AS costCents,
    SUM(CASE WHEN equivalent_cost_cents IS NULL THEN request_count ELSE 0 END) AS unpriced
    FROM usage_events WHERE timestamp >= ? AND timestamp < ?
    ${source === "all" ? "" : "AND source = ?"}
    GROUP BY source, model, effort, fast ORDER BY SUM(equivalent_cost_cents) DESC, source, model
  `).all(start, end, ...(source === "all" ? [] : [source]));
  const result = ReceiptModel.build(rows, { date, source, period, ...options });
  if (source === "devin") result.costNote = "模型 API 等值估算 · 非 Devin 订阅扣费";
  const deepseekCosts = rows.some(row=>row.source==='deepseek'&&row.costCents!=null);
  const converted = deepseekCosts ? history.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE timestamp >= ? AND timestamp < ?
    AND source = 'deepseek' AND pricing_status = 'official-billing-fx'`).get(start,end).n : 0;
  const estimated = deepseekCosts ? history.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE timestamp >= ? AND timestamp < ?
    AND source = 'deepseek' AND pricing_status = 'estimated-deepseek-cny-fx'`).get(start,end).n : 0;
  if (converted && ["all","deepseek"].includes(source)) result.costNote = source === "deepseek"
    ? "官方日账单实收 · 按历史汇率折算美元" : "API 等值费用 · 含 DeepSeek 官方账单美元换算";
  if (estimated && ["all","deepseek"].includes(source)) result.costNote = converted
    ? "含官方日账单实收及本机会话估算 · 按消费日汇率折算美元" : "含本机 DeepSeek 会话估算 · 按官方单价及消费日汇率计算";
  return result;
}

module.exports = { dayBounds, getReceipt };
