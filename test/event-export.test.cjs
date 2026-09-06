const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UsageHistory } = require("../src/history.cjs");
const { csvCell, exportUsageEvents } = require("../src/event-export.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-export-"));
  const history = new UsageHistory(path.join(dir, "history.sqlite"));
  t.after(() => { history.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, history };
}
const event = (id, extra = {}) => ({ source: "codex", eventKey: `event:${id}`, timestamp: 1000,
  model: "model-demo", input: 15, output: 3, cacheRead: 20, cacheWrite: 2,
  fastKnown: false, equivalentCostCents: 0.123456, ...extra });

test("exports more than 8000 events exactly once, preserving costs and unknown speed", (t) => {
  const { dir, history } = fixture(t);
  history.upsertEvents(Array.from({ length: 8205 }, (_, id) => event(id)));
  const filePath = path.join(dir, "events.json");
  const result = exportUsageEvents(history, { filePath, kind: "json" });
  const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(result.count, 8205);
  assert.equal(new Set(rows.map((row) => row.eventKey)).size, 8205);
  assert.equal(rows[0].equivalentCostCents, 0.123456);
  assert.equal(rows[0].fastKnown, false);
  assert.equal(rows[0].cacheRead, 20);
  assert.deepEqual(rows.slice(0, 40), history.queryEvents().events);
  assert.deepEqual(rows.slice(40, 80), history.queryEvents({ offset: 40 }).events);
});

test("search and export share literal wildcard, backslash and source filters", (t) => {
  const { dir, history } = fixture(t);
  history.upsertEvents([event(1, { model: "a_%\\b" }), event(2, { model: "axxb" }),
    event(3, { source: "cursor", model: "a_%\\b" }), event(4, { model: "plain", effort: "high" })]);
  const expected = history.queryEvents({ sources: "codex", query: "_%\\" }).events;
  assert.equal(expected.length, 1);
  const filePath = path.join(dir, "filtered.json");
  exportUsageEvents(history, { filePath, kind: "json", source: "codex", query: "_%\\" });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath)), expected);
  assert.equal(history.queryEvents({ query: "high" }).total, 1);
  exportUsageEvents(history, { filePath, kind: "json", query: "absent" });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath)), []);
});

test("CSV prevents formula execution and preserves quoted multiline fields", () => {
  for (const value of ["=1+2", "+CMD()", "-1+2", "@SUM(1)", "  =1", "\t=1", "\r=1", "\n=1", "\uFEFF=1"]) {
    assert.ok(csvCell(value).replace(/^"/, "").startsWith("'"), value);
  }
  assert.equal(csvCell('a,"b"\rc'), '"a,""b""\rc"');
  assert.equal(csvCell("gpt-model"), "gpt-model");
  assert.equal(csvCell(null), "");
});

test("CSV includes every matching row and keeps unknown costs empty", (t) => {
  const { dir, history } = fixture(t);
  history.upsertEvents([event(1, { model: "=DANGER()", equivalentCostCents: null }), event(2)]);
  const filePath = path.join(dir, "events.csv");
  assert.equal(exportUsageEvents(history, { filePath, kind: "csv" }).count, 2);
  const csv = fs.readFileSync(filePath, "utf8");
  assert.ok(csv.startsWith("\uFEFF时间,"));
  assert.match(csv, /'=DANGER\(\),,unknown,15,2,20,3,\r\n/);
  assert.equal(csv.split("\r\n").length, 4);
});

test("a failed export preserves the destination and removes its partial file", (t) => {
  const { dir } = fixture(t);
  const filePath = path.join(dir, "events.json");
  fs.writeFileSync(filePath, "previous export");
  const brokenHistory = { *iterateEvents() { yield event(1); throw new Error("read failed"); } };
  assert.throws(() => exportUsageEvents(brokenHistory, { filePath, kind: "json" }), /read failed/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "previous export");
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
});

test("an export cursor retains its snapshot when another connection writes", (t) => {
  const { dir, history } = fixture(t);
  history.upsertEvents([event(1), event(2)]);
  const writer = new UsageHistory(history.dbPath);
  try {
    const wrapped = { *iterateEvents(options) {
      let first = true;
      for (const row of history.iterateEvents(options)) {
        if (first) { first = false; writer.upsertEvents([event(3, { timestamp: 2000 })]); }
        yield row;
      }
    } };
    const filePath = path.join(dir, "snapshot.json");
    assert.equal(exportUsageEvents(wrapped, { filePath, kind: "json" }).count, 2);
    assert.equal(history.queryEvents().total, 3);
  } finally { writer.close(); }
});
