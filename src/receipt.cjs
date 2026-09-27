// Read one local calendar day from a single SQLite snapshot; never reprice history.
function dayBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("请选择有效日期");
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error("日期无效");
  return { start: +start, end: +new Date(year, month - 1, day + 1) };
}

function getReceipt(history, { date, source = "all" } = {}) {
  const { start, end } = dayBounds(date);
  if (!["all", "cursor", "codex"].includes(source)) throw new Error("数据来源无效");
  const rows = history.db.prepare(`SELECT source, model,
    SUM(request_count) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
    SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
    SUM(equivalent_cost_cents) AS costCents,
    SUM(CASE WHEN equivalent_cost_cents IS NULL THEN request_count ELSE 0 END) AS unpriced
    FROM usage_events WHERE timestamp >= ? AND timestamp < ?
    ${source === "all" ? "" : "AND source = ?"}
    GROUP BY source, model ORDER BY SUM(equivalent_cost_cents) DESC, source, model
  `).all(start, end, ...(source === "all" ? [] : [source]));
  return { date, source, generatedAt: Date.now(), rows };
}

module.exports = { dayBounds, getReceipt };
