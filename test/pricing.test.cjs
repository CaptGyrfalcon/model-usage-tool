const test = require("node:test");
const assert = require("node:assert/strict");
const { FALLBACK_MODELS, builtInSnapshot, parseOpenAiPricing, parseCursorPricing, priceEvent, modelKey, mergeFallbackCatalog } = require("../src/pricing.cjs");

test("Codex review token updates carry no fee; completed turn carries the flat fee", () => {
  const event = { source: "codex", model: "codex-auto-review", input: 10000, output: 500, fast: true, fastKnown: false };
  const priced = priceEvent(event, null);
  for (const [key, value] of Object.entries(priced)) {
    if (key.endsWith("Cents")) assert.equal(value, 0, key);
  }
  assert.equal(priced.pricingStatus, "codex-hypothesis-2026-09-27-v2-review-token-only");
  assert.equal(event.input, 10000);
  assert.equal(priceEvent({ ...event, source: "cursor" }, null).pricingStatus, "unavailable");
  assert.equal(priceEvent({ ...event, model: "another-unknown-model" }, null).pricingStatus, "unavailable");
});

test("parses Standard and Fast OpenAI pricing tables", () => {
  const markdown = `
gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00
gpt-5.6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00
gpt-5.6-sol | $8.00 | $0.80 | $10.00 | $40.00 | $16.00 | $1.60 | $20.00 | $60.00
`;
  const models = parseOpenAiPricing(markdown);
  assert.equal(models["gpt-5.6-sol"].standard.short.input, 4);
  assert.equal(models["gpt-5.6-sol"].fast.short.output, 40);
  assert.equal(models["gpt-5.6-sol"].fast.long.output, 60);
});

test("prices cache/input/output separately and treats unknown Fast as non-fast", () => {
  const snapshot = { id: 7, models: FALLBACK_MODELS };
  const event = {
    source: "codex", model: "gpt-5.6-sol", input: 100_000, cacheRead: 100_000,
    cacheWrite: 50_000, output: 100_000, fast: false, fastKnown: false,
  };
  const priced = priceEvent(event, snapshot);
  assert.ok(Math.abs(priced.inputCostCents - 44) < 1e-10);
  assert.equal(priced.cacheReadCostCents, 4.4);
  assert.equal(priced.cacheWriteCostCents, 27.5);
  assert.equal(priced.cacheCostCents, 31.9);
  assert.equal(priced.outputCostCents, 220);
  assert.equal(priced.equivalentCostLowCents, 295.9);
  assert.equal(priced.equivalentCostHighCents, 295.9);
  assert.equal(priced.quotaEquivalentCostLowCents, 295.9);
  assert.equal(priced.quotaEquivalentCostHighCents, 295.9);
  assert.equal(priced.pricingStatus, "codex-hypothesis-2026-09-27-v2-tier-unknown");
});

test("uses Cursor official cache-write rows only for Cursor events", () => {
  const cursorModels = parseCursorPricing(`
OpenAI GPT-5.6 Sol | $4 | $5 | $0.4 | $20
Cursor Grok 4.6 | $2 | - | $0.5 | $6
  `, {});
  const snapshot = {
    models: FALLBACK_MODELS,
    modelsBySource: { cursor: cursorModels, codex: FALLBACK_MODELS },
  };
  const gpt = priceEvent({
    source: "cursor", model: "gpt-5.6-sol", input: 0, cacheRead: 0,
    cacheWrite: 100_000, output: 0, fast: false, fastKnown: true,
  }, snapshot);
  const grok = priceEvent({
    source: "cursor", model: "grok-4.6", input: 0, cacheRead: 0,
    cacheWrite: 100_000, output: 0, fast: false, fastKnown: true,
  }, snapshot);
  assert.equal(gpt.cacheWriteCostCents, 50);
  assert.equal(grok.cacheWriteCostCents, 0);
});

test("keeps Codex and Cursor GPT price catalogs isolated by official source", () => {
  const snapshot = builtInSnapshot(1);
  assert.equal(snapshot.modelsBySource.codex["gpt-5.6-sol"].provider, "openai");
  assert.equal(snapshot.modelsBySource.cursor["gpt-5.6-sol"].provider, "cursor");
  assert.equal(snapshot.modelsBySource.cursor["gpt-5.6-sol"].fast, undefined);
});

test("uses one 2.5x dollar-equivalent and credit basis for GPT-5.6 Fast", () => {
  const snapshot = { id: 8, models: FALLBACK_MODELS };
  const priced = priceEvent({
    source: "codex", model: "gpt-5.6-sol", input: 100_000, cacheRead: 100_000,
    output: 100_000, fast: true, fastKnown: true,
  }, snapshot);
  assert.equal(priced.equivalentCostCents, 671);
  assert.equal(priced.quotaEquivalentCostCents, 671);
});

test("parses GPT-6 Astra Standard and Fast OpenAI pricing tables", () => {
  const markdown = `
gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00
gpt-6-astra | $5.00 | $0.50 | $6.25 | $25.00 | $10.00 | $1.00 | $12.50 | $37.50
gpt-6-astra | $20.00 | $2.00 | $25.00 | $100.00 | $40.00 | $4.00 | $50.00 | $150.00
`;
  const models = parseOpenAiPricing(markdown);
  assert.equal(models["gpt-6-astra"].standard.short.input, 10);
  assert.equal(models["gpt-6-astra"].standard.short.cacheWrite, 12.5);
  assert.equal(models["gpt-6-astra"].standard.long.output, 75);
  assert.equal(models["gpt-6-astra"].fast.short.output, 100);
  assert.equal(models["gpt-6-astra"].fast.long.input, 40);
});

test("aliases gpt-6 to gpt-6-astra and prices it from the built-in catalog", () => {
  assert.equal(modelKey("gpt-6"), "gpt-6-astra");
  assert.equal(modelKey("gpt-6-astra-xhigh-fast"), "gpt-6-astra");
  const priced = priceEvent({
    source: "codex", model: "gpt-6", input: 100_000, output: 10_000,
    cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true,
  }, { id: 9, models: {}, modelsBySource: { codex: {}, cursor: {} } });
  assert.equal(priced.inputCostCents, 150);
  assert.equal(priced.outputCostCents, 75);
  assert.equal(priced.equivalentCostCents, 225);
  assert.notEqual(priced.pricingStatus, "unavailable");
});

test("uses 2.5x Codex credit for GPT-6 Astra Fast and skips long-context surcharge", () => {
  const snapshot = builtInSnapshot(1);
  const fast = priceEvent({
    source: "codex", model: "gpt-6-astra", input: 100_000, output: 10_000,
    cacheRead: 0, cacheWrite: 0, fast: true, fastKnown: true,
  }, snapshot);
  assert.equal(fast.equivalentCostCents, 562.5);
  assert.equal(fast.quotaEquivalentCostCents, 562.5);

  const longAstra = priceEvent({
    source: "codex", model: "gpt-6-astra", input: 300_000, output: 0,
    cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true,
  }, snapshot);
  assert.equal(longAstra.inputCostCents, 450);

  const longSol = priceEvent({
    source: "codex", model: "gpt-5.6-sol", input: 300_000, output: 0,
    cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true,
  }, snapshot);
  assert.equal(longSol.inputCostCents, 132);
});

test("fills GPT-6 Astra into a cached catalog that predates the model", () => {
  const merged = mergeFallbackCatalog({
    id: 4,
    models: { "gpt-5.6-sol": FALLBACK_MODELS["gpt-5.6-sol"] },
    modelsBySource: { codex: {}, cursor: {} },
  });
  assert.equal(merged.modelsBySource.codex["gpt-6-astra"].standard.short.input, 10);
  assert.equal(merged.modelsBySource.cursor["gpt-6-astra"].standard.short.output, 50);
});

test('discovers new models and matches exact IDs without confusing Batch with Fast', () => {
  const models = parseOpenAiPricing(`
gpt-6-future | $2 | $0.2 | $2.5 | $10 | $4 | $0.4 | $5 | $15
gpt-6-future-pro | $99 | $9 | $100 | $100 | $99 | $9 | $100 | $100
gpt-6-future | $1 | $0.1 | $1.25 | $5 | $2 | $0.2 | $2.5 | $7.5
`, {});
  assert.equal(models['gpt-6-future'].standard.short.output, 10);
  assert.equal(models['gpt-6-future'].fast, undefined);
  assert.equal(models['gpt-6-future-pro'].standard.short.input, 99);
});

test("keeps Grok 4.7 standard, Fast, and 500k rates separate", () => {
  const models = parseCursorPricing(`
Grok 4.7 | $2 | - | $0.5 | $6
Grok 4.7 (Fast) | $4 | - | $1 | $12
Grok 4.7 500k | $4 | - | $1 | $12
Grok 4.7 500k (Fast) | $6 | - | $1.5 | $18
`, {});
  assert.equal(models["grok-4.7"].standard.short.input, 2);
  assert.equal(models["grok-4.7"].fast.short.output, 12);
  assert.equal(models["grok-4.7-500k"].standard.short.input, 4);
  assert.equal(models["grok-4.7-500k"].fast.short.output, 18);
  assert.equal(modelKey("grok-4.7-high-fast"), "grok-4.7");
});

test("backfills an unavailable Cursor price without increasing its token count", () => {
  const { UsageHistory } = require("../src/history.cjs");
  class Fixture extends UsageHistory { migrateLegacyHistory() {} }
  const history = new Fixture(":memory:");
  try {
    const event = { source: "cursor", eventKey: "grok-test", timestamp: 1000,
      model: "grok-4.7-high-fast", pool: "cursor-models", input: 1000,
      output: 100, costCents: 25, pricingStatus: "unavailable" };
    history.upsertEvents([event]);
    const priced = priceEvent(event, builtInSnapshot(1), { authoritativeTotalCents: 25 });
    history.upsertEvents([{ ...event, ...priced }]);
    assert.equal(history.getEvent("cursor", "grok-test").equivalentCostCents, 25);
    assert.equal(history.getUnpricedEvents().length, 0);
  } finally { history.close(); }
});

test("uses Cursor's authoritative total when Auto hides the routed model", () => {
  const priced = priceEvent({ source: "cursor", model: "default", input: 1000, output: 200 },
    builtInSnapshot(1), { authoritativeTotalCents: 37.25 });
  assert.equal(priced.equivalentCostCents, 37.25);
  assert.equal(priced.quotaEquivalentCostCents, 37.25);
  assert.equal(priced.inputCostCents, null);
  assert.equal(priced.pricingStatus, "api-total-unallocated");
  assert.equal(priceEvent({ source: "cursor", model: "default" }, builtInSnapshot(1),
    { authoritativeTotalCents: 30, authoritativeSource: "charged-total" }).pricingStatus, "charged-total-unallocated");
  assert.equal(priceEvent({ source: "cursor", model: "default" }, builtInSnapshot(1)).pricingStatus, "unavailable");
});

test('GPT-6 Sol and Luna fill old catalogs and backfill missing costs without rewriting locked costs', () => {
  const { UsageHistory } = require('../src/history.cjs');
  class Fixture extends UsageHistory { migrateLegacyHistory() {} }
  const h = new Fixture(':memory:');
  try {
    const old = { models: {}, modelsBySource: { codex: {}, cursor: {} } };
    const snapshot = mergeFallbackCatalog(old);
    for (const [model, expected] of [['gpt-6-sol', 1830], ['gpt-6-luna', 152.5]]) {
      const event = { source: 'codex', eventKey: model, timestamp: 1000, model,
        input: 1e6, cacheRead: 1e6, output: 1e6, fastKnown: false, pricingStatus: 'unavailable' };
      h.upsertEvents([event]);
      const p = priceEvent(h.getEvent('codex', model), old, { fallbackSnapshot: snapshot });
      assert.ok(Math.abs(p.equivalentCostCents - expected) < 1e-8);
      h.upsertEvents([{ ...event, ...p }]);
      h.upsertEvents([{ ...event, ...p, equivalentCostCents: 99999 }]);
      assert.ok(Math.abs(h.getEvent('codex', model).equivalentCostCents - expected) < 1e-8);
      const fast = priceEvent({ ...event, fastKnown: true, fast: true }, snapshot);
      assert.ok(Math.abs(fast.equivalentCostCents - expected * 2.5) < 1e-8);
    }
    assert.equal(h.getUnpricedEvents().length, 0);
  } finally { h.close(); }
});

test('refresh rejects unreadable price pages and retains previous source prices', async () => {
  const { refreshPricing } = require('../src/pricing.cjs');
  const original = global.fetch;
  const prior = builtInSnapshot(1);
  prior.modelsBySource.codex['gpt-6-sol'].standard.short.input = 3;
  global.fetch = async () => ({ ok: true, text: async () => '<html>temporarily unavailable</html>' });
  try {
    const result = await refreshPricing({ latestPricingSnapshot: () => prior,
      loadCache: () => null, saveCache() {}, savePricingSnapshot: () => 1 }, { force: true });
    assert.equal(result.updated, false);
    assert.equal(result.errors.length, 2);
    assert.equal(result.snapshot.modelsBySource.codex['gpt-6-sol'].standard.short.input, 3);
  } finally { global.fetch = original; }
});
