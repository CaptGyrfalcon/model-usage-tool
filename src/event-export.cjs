const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ModelDisplay = require("./renderer/model-display.js");

// Spreadsheet programs interpret formula prefixes even inside quoted CSV fields.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(event) {
  return [new Date(event.timestamp).toISOString(), event.source, ModelDisplay.format(event, { precision: "coarse" }),
    ModelDisplay.effort(event.effort || ModelDisplay.descriptor(event.model).effort), event.fastKnown === false ? "unknown" : event.fast ? "fast" : "standard",
    event.input, event.cacheWrite, event.cacheRead, event.output,
    event.equivalentCostCents == null ? "" : (Number(event.equivalentCostCents) / 100).toFixed(6),
  ].map(csvCell).join(",");
}

// Called in the data worker. One SQLite cursor gives a consistent snapshot and
// bounded memory, without OFFSET rescans or transferring all history over IPC.
function exportUsageEvents(history, { filePath, kind, source = "all", query = "" }) {
  if (!["csv", "json"].includes(kind)) throw new Error("不支持的导出格式");
  const temp = path.join(path.dirname(filePath), `.usage-export-${randomUUID()}.tmp`);
  let fd;
  let count = 0;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, kind === "csv"
      ? "\uFEFF时间,来源,模型,effort,速度,输入,写缓存,读缓存,输出,美元等效\r\n" : "[\n");
    let buffer = "";
    for (const event of history.iterateEvents({ sources: source === "all" ? undefined : source, query })) {
      buffer += kind === "csv" ? `${csvRow(event)}\r\n` : `${count ? ",\n" : ""}${JSON.stringify(event)}`;
      count += 1;
      if (buffer.length >= 65536) { fs.writeFileSync(fd, buffer); buffer = ""; }
    }
    fs.writeFileSync(fd, buffer + (kind === "json" ? "\n]\n" : ""));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    return { ok: true, count, path: filePath };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

module.exports = { csvCell, csvRow, exportUsageEvents };
