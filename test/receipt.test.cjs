const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { dayBounds, getReceipt } = require("../src/receipt.cjs");
const ReceiptModel = require("../src/renderer/receipt-model.js");

test("receipt provider mapping covers brands, casing and family aliases with bundled icons", () => {
  const context = { window: {} };
  require("node:vm").runInNewContext(require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/renderer/brand-icons.js"), "utf8"), context);
  const families = {
    zai: ["glm-5.2", "GLM-5.2", "chatglm-6b", "z-ai/glm-5", "zhipu-glm-4"],
    anthropic: ["claude-4.6-sonnet-medium-thinking"],
    grok: ["cursor-grok-4.6-high-fast"], openai: ["gpt-6-sol", "o3", "codex-auto-review"],
    gemini: ["gemini-2.5-pro"], gemma: ["gemma-3-27b"], deepseek: ["DeepSeek-V4 pro"],
    qwen: ["qwen3", "qwq-32b"], mistral: ["mistral-large", "codestral", "devstral", "ministral", "pixtral", "magistral"],
    meta: ["llama-4"], minimax: ["MiniMax-M2"], moonshot: ["kimi-k2-instruct", "moonshot-v1"],
    cursor: ["composer-2.5-fast", "auto", "default", "cursor-auto-high"],
    devin: ["swe-2", "SWE-2-high", "swe-2-max"],
  };
  for (const [provider, names] of Object.entries(families)) {
    for (const name of names) assert.equal(ReceiptModel.provider(name), provider, name);
    const svg = Buffer.from(context.window.ReceiptBrandIcons[provider].split(",")[1], "base64").toString();
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<script\b|https?:\/\/[^\s"]+\.(?:png|jpg)/);
  }
  assert.equal(ReceiptModel.provider("unknown"), null);
  assert.equal(context.window.ReceiptBrandIcons.zhipu, undefined);
  const devinSvg = Buffer.from(context.window.ReceiptBrandIcons.devin.split(",")[1], "base64").toString();
  assert.match(devinSvg, /<title>Devin<\/title>/);
  assert.match(devinSvg, /M8\.30437 8\.18853/); // Official symbol, shared by channel and SWE model rows.
  assert.doesNotMatch(devinSvg, /M5 3h6|<text\b/);
  assert.match(Buffer.from(context.window.ReceiptBrandIcons.zai.split(",")[1], "base64").toString(), /<title>Z.ai<\/title>/);
});

test("receipt periods follow local calendar boundaries including cross-year weeks and leap months", () => {
  for (const [date, period, start, end] of [
    ["2026-09-27", "week", new Date(2026, 8, 21), new Date(2026, 8, 28)],
    ["2026-01-01", "week", new Date(2025, 11, 29), new Date(2026, 0, 5)],
    ["2024-02-29", "month", new Date(2024, 1, 1), new Date(2024, 2, 1)],
    ["2026-12-31", "month", new Date(2026, 11, 1), new Date(2027, 0, 1)],
    ["2024-02-29", "year", new Date(2024, 0, 1), new Date(2025, 0, 1)],
  ]) {
    const bounds = ReceiptModel.range(date, period);
    assert.equal(bounds.start, +start);
    assert.equal(bounds.end, +end);
  }
  assert.throws(() => ReceiptModel.range("2026-01-01", "invalid"));
  assert.deepEqual(["day", "week", "month", "year"].map(ReceiptModel.defaults), [
    { splitEffort: true, splitSpeed: true }, { splitEffort: false, splitSpeed: true },
    { splitEffort: false, splitSpeed: false }, { splitEffort: false, splitSpeed: false },
  ]);
});

test("receipt grouping independently merges effort and speed, normalizes names and conserves costs and tokens", () => {
  const rows = [
    { model: "gpt-6-sol", effort: "high", fast: 0 },
    { model: "gpt-6-sol-high-fast", effort: null, fast: 1 },
    { model: "gpt-6-sol", effort: "low", fast: 0 },
    { model: "gpt-6-sol", effort: "low", fast: 1 },
  ].map((r) => ({ ...r, source: "codex", costCents: 10, count: 1, input: 100, output: 20 }));
  for (const [splitEffort, splitSpeed, count] of [[true, true, 4], [true, false, 2], [false, true, 2], [false, false, 1]]) {
    const result = ReceiptModel.build(rows, { date: "2026-09-27", splitEffort, splitSpeed });
    assert.equal(result.rows.length, count);
    assert.equal(result.rows.reduce((sum, r) => sum + r.costCents, 0), 40);
    assert.equal(result.rows.reduce((sum, r) => sum + r.input, 0), 400);
    assert.equal(result.rows.reduce((sum, r) => sum + r.count, 0), 4);
    assert.ok(result.rows.every((r) => r.label.startsWith("GPT 6 Sol")));
    assert.ok(result.rows.every((r) => !r.label.includes("gpt-6-sol")));
  }
  const result = ReceiptModel.build([
    { ...rows[0], fast: null, effort: null, costCents: null, unpriced: 1 }, rows[0],
    { ...rows[0], source: "cursor" },
  ], { date: "2026-09-27" });
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.some((r) => r.label.includes("思考程度未知") && r.label.includes("non-fast") && r.costCents === null));
  const monthly = ReceiptModel.build(rows, { date: "2026-09-27", period: "month" });
  assert.deepEqual(monthly.rows.map((r) => r.label), ["GPT 6 Sol"]);
});

test("receipt merges Composer efforts, unknown speeds and all Auto variants without losing usage", () => {
  const rows = [
    { model: "composer-2.5", effort: "high", fast: 0 },
    { model: "cursor-composer-2.5-low", effort: null, fast: null },
    { model: "composer-2.5-fast", effort: "medium", fast: 1 },
    { model: "auto", effort: "high", fast: 1 },
    { model: "default", effort: "low", fast: 0 },
    { model: "auto", effort: null, fast: null },
    { model: "gpt-6-sol", effort: "high", fast: null },
    { model: "gpt-6-sol", effort: "high", fast: 0 },
    { model: "gpt-6-sol", effort: "high", fast: 1 },
  ].map((row) => ({ ...row, source: "cursor", count: 1, input: 100, costCents: 10 }));
  const original = structuredClone(rows);
  const result = ReceiptModel.build(rows, { date: "2026-09-27" });
  const groups = new Map(result.rows.map((row) => [row.label, row]));
  assert.equal(groups.size, 5);
  assert.equal(groups.get("Composer 2.5 · non-fast").count, 2);
  assert.equal(groups.get("Composer 2.5 · Fast").count, 1);
  assert.equal(groups.get("Auto").count, 3);
  assert.equal(groups.get("GPT 6 Sol · High · non-fast").count, 2);
  assert.equal(groups.get("GPT 6 Sol · High · Fast").count, 1);
  assert.equal(result.rows.reduce((sum, row) => sum + row.costCents, 0), 90);
  assert.equal(result.rows.reduce((sum, row) => sum + row.input, 0), 900);
  assert.deepEqual(rows, original);
  for (const splitEffort of [true, false]) for (const splitSpeed of [true, false]) {
    const grouped = ReceiptModel.build(rows, { date: "2026-09-27", splitEffort, splitSpeed });
    assert.equal(grouped.rows.filter((row) => row.label === "Auto").length, 1);
    assert.ok(grouped.rows.filter((row) => row.label.startsWith("Composer")).every((row) => !/High|Low|Medium|未知/.test(row.label)));
    if (!splitSpeed) assert.equal(grouped.rows.find((row) => row.label === "Composer 2.5").count, 3);
  }
});

test("unknown models are hidden from receipt details but remain in request totals", () => {
  const data = ReceiptModel.build([
    { source: "codex", model: "unknown", count: 10, unpriced: 10, costCents: null },
    { source: "codex", model: "gpt-6-sol", count: 3, costCents: 25 },
    { source: "cursor", model: "default", count: 2, costCents: 5 },
  ], { date: "2026-09-27" });
  const details = ReceiptModel.detailRows(data.rows);
  assert.deepEqual(new Set(details.map((r) => r.model)), new Set(["gpt-6-sol", "default"]));
  assert.equal(data.rows.reduce((sum, r) => sum + r.count, 0), 15);
  assert.equal(data.rows.reduce((sum, r) => sum + (r.costCents || 0), 0), 30);
  assert.equal(ReceiptModel.detailRows(data.rows.filter((r) => r.model === "unknown")).length, 0);
});

test("model sorting orders providers, numeric versions, model tiers, speed and effort independently of cost", () => {
  const rows = [
    ["gpt-5.6-astra", "high", 1], ["gpt-6-luna", "high", 1],
    ["gpt-6-sol", "high", 0], ["gpt-6-astra", "high", 1],
    ["gpt-6-sol", "low", 1], ["gpt-6-sol", "high", 1],
    ["gpt-6-sol", "ultra", 0], ["gpt-6-sol", "xhigh", 1],
    ["gpt-5.10-sol", "high", 1], ["glm-5.2", "high", 0],
    ["claude-sonnet-4-6", "high", 0], ["claude-opus-4-6", "high", 0],
  ].map(([model, effort, fast], i) => ({ source: "cursor", model, effort, fast, count: 1, costCents: 100 - i }));
  const result = ReceiptModel.build(rows, { date: "2026-09-27", sort: "model" });
  assert.deepEqual(result.rows.map((row) => row.label), [
    "Claude Opus 4.6 · High · non-fast", "Claude Sonnet 4.6 · High · non-fast",
    "GPT 6 Astra · High · Fast", "GPT 6 Sol · Xhigh · Fast", "GPT 6 Sol · High · Fast",
    "GPT 6 Sol · Low · Fast", "GPT 6 Sol · Ultra · non-fast", "GPT 6 Sol · High · non-fast",
    "GPT 6 Luna · High · Fast", "GPT 5.10 Sol · High · Fast", "GPT 5.6 Astra · High · Fast", "GLM 5.2 · High · non-fast",
  ]);
  assert.deepEqual(ReceiptModel.build([...rows].reverse(), { date: "2026-09-27", sort: "model" }).rows.map((r) => r.label), result.rows.map((r) => r.label));
  const merged = ReceiptModel.build(rows, { date: "2026-09-27", sort: "model", splitEffort: false, splitSpeed: false });
  assert.deepEqual(merged.rows.filter((r) => r.label.startsWith("GPT 6")).map((r) => r.label), ["GPT 6 Astra", "GPT 6 Sol", "GPT 6 Luna"]);
  assert.equal(merged.rows.reduce((sum, r) => sum + r.costCents, 0), rows.reduce((sum, r) => sum + r.costCents, 0));
  const cost = ReceiptModel.build(rows, { date: "2026-09-27", sort: "cost" });
  assert.equal(cost.rows[0].model, "gpt-5.6-astra");
});

test("receipt validates calendar days and uses local midnight boundaries", () => {
  assert.throws(() => dayBounds("2026-02-30"));
  assert.throws(() => dayBounds("2026-9-27"));
  assert.throws(() => dayBounds(""));
  const { start, end } = dayBounds("2026-09-27");
  assert.equal(start, +new Date(2026, 8, 27));
  assert.equal(end, +new Date(2026, 8, 28));
  assert.equal(new Date(dayBounds("2024-02-29").end).getDate(), 1);
});

test("daily receipt groups all events, excludes adjacent days, preserves unknown prices and stored costs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE usage_events (source TEXT, model TEXT, timestamp INTEGER,
      request_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, equivalent_cost_cents REAL, effort TEXT, fast INTEGER)`);
    const insert = db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)");
    const { start, end } = dayBounds("2026-09-27");
    insert.run("cursor", "claude", start - 1, 1, 1, 1, 0, 0, 999);
    insert.run("cursor", "claude", start, 2, 100, 20, 500, 30, 12.5);
    insert.run("cursor", "claude", end - 1, 3, 50, 5, 100, 0, null);
    insert.run("codex", "gpt", start, 1, 30, 10, 70, 0, 0);
    insert.run("cursor", "unknown", start, 1, 20, 10, 0, 0, null);
    insert.run("codex", "gpt", end, 1, 1, 1, 0, 0, 999);
    const all = getReceipt({ db }, { date: "2026-09-27" });
    assert.equal(all.rows.length, 3);
    const claude = all.rows.find((r) => r.model === "claude");
    assert.equal(claude.count, 5);
    assert.equal(claude.input, 150);
    assert.equal(claude.cacheRead, 600);
    assert.equal(claude.costCents, 12.5);
    assert.equal(claude.unpriced, 3);
    assert.equal(all.rows.find((r) => r.model === "unknown").costCents, null);
    const codex = getReceipt({ db }, { date: "2026-09-27", source: "codex" });
    assert.equal(codex.rows.length, 1);
    assert.equal(codex.rows[0].costCents, 0);
    assert.equal(codex.rows[0].unpriced, 0);
    assert.equal(getReceipt({ db }, { date: "2026-01-01" }).rows.length, 0);
    const week = getReceipt({ db }, { date: "2026-09-27", period: "week" });
    assert.equal(week.rows.reduce((sum, r) => sum + (r.costCents || 0), 0), 1011.5);
    for (const period of ["month", "year"]) {
      const longer = getReceipt({ db }, { date: "2026-09-27", period });
      assert.equal(longer.rows.reduce((sum, r) => sum + (r.costCents || 0), 0), 2010.5);
      assert.equal(longer.rows.reduce((sum, r) => sum + r.count, 0), 9);
    }
    assert.throws(() => getReceipt({ db }, { date: "2026-09-27", source: "invalid" }));
  } finally { db.close(); }
});
