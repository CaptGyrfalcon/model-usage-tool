const test = require("node:test");
const assert = require("node:assert/strict");
const { builtInSnapshot } = require("../src/pricing.cjs");
const { flattenPricingSnapshot } = require("../src/pricing-table.cjs");

test("splits each model into Fast and non-Fast rows", () => {
  const rows = flattenPricingSnapshot(builtInSnapshot(1));
  const grok = rows.filter((row) => row.source === "cursor" && row.model === "grok-4.6");
  assert.deepEqual(grok.map((row) => row.speedLabel), ["非 Fast", "Fast"]);
  assert.equal(grok[0].input, 2);
  assert.equal(grok[1].input, 4);
});

test("keeps Codex long-context rates as a separate tier", () => {
  const rows = flattenPricingSnapshot(builtInSnapshot(1), { source: "codex" });
  const sol = rows.filter((row) => row.model === "gpt-5.6-sol");
  assert.ok(sol.some((row) => row.speed === "standard" && row.context === "default" && row.input === 4));
  assert.ok(sol.some((row) => row.speed === "standard" && row.context === "long" && row.input === 8));
  assert.ok(sol.some((row) => row.speed === "fast" && row.context === "default"));
  const astra = rows.filter((row) => row.model === "gpt-6-astra");
  assert.ok(astra.some((row) => row.speed === "standard" && row.context === "default" && row.input === 10));
  assert.ok(astra.some((row) => row.speed === "fast" && row.context === "long" && row.output === 150));
});

test("models without Fast only expose the non-Fast tier", () => {
  const rows = flattenPricingSnapshot(builtInSnapshot(1), { source: "cursor" });
  const claude = rows.filter((row) => row.model === "claude-sonnet-5");
  assert.deepEqual(claude.map((row) => row.speed), ["standard"]);
});
