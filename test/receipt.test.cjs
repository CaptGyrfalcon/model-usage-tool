const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { dayBounds, getReceipt } = require("../src/receipt.cjs");

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
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, equivalent_cost_cents REAL)`);
    const insert = db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
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
    assert.throws(() => getReceipt({ db }, { date: "2026-09-27", source: "invalid" }));
  } finally { db.close(); }
});
