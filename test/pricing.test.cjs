const test = require("node:test");
const assert = require("node:assert/strict");
const { FALLBACK_MODELS, builtInSnapshot, parseOpenAiPricing, parseCursorPricing, priceEvent, modelKey, mergeFallbackCatalog } = require("../src/pricing.cjs");

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

test("prices cache/input/output separately and keeps unknown Fast range", () => {
  const snapshot = { id: 7, models: FALLBACK_MODELS };
  const event = {
    source: "codex", model: "gpt-5.6-sol", input: 100_000, cacheRead: 100_000,
    cacheWrite: 50_000, output: 100_000, fast: false, fastKnown: false,
  };
  const priced = priceEvent(event, snapshot);
  assert.equal(priced.inputCostCents, 40);
  assert.equal(priced.cacheReadCostCents, 4);
  assert.equal(priced.cacheWriteCostCents, 25);
  assert.equal(priced.cacheCostCents, 29);
  assert.equal(priced.outputCostCents, 200);
  assert.equal(priced.equivalentCostLowCents, 269);
  assert.equal(priced.equivalentCostHighCents, 672.5);
  assert.equal(priced.quotaEquivalentCostLowCents, 269);
  assert.equal(priced.quotaEquivalentCostHighCents, 672.5);
  assert.equal(priced.pricingStatus, "official-standard-rate-credit-multiplier-tier-unknown");
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
  assert.equal(priced.equivalentCostCents, 610);
  assert.equal(priced.quotaEquivalentCostCents, 610);
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
  assert.equal(priced.inputCostCents, 100);
  assert.equal(priced.outputCostCents, 50);
  assert.equal(priced.equivalentCostCents, 150);
  assert.notEqual(priced.pricingStatus, "unavailable");
});

test("uses 2.5x Codex credit for GPT-6 Astra Fast and skips long-context surcharge", () => {
  const snapshot = builtInSnapshot(1);
  const fast = priceEvent({
    source: "codex", model: "gpt-6-astra", input: 100_000, output: 10_000,
    cacheRead: 0, cacheWrite: 0, fast: true, fastKnown: true,
  }, snapshot);
  assert.equal(fast.equivalentCostCents, 375);
  assert.equal(fast.quotaEquivalentCostCents, 375);

  const longAstra = priceEvent({
    source: "codex", model: "gpt-6-astra", input: 300_000, output: 0,
    cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true,
  }, snapshot);
  assert.equal(longAstra.inputCostCents, 300);

  const longSol = priceEvent({
    source: "codex", model: "gpt-5.6-sol", input: 300_000, output: 0,
    cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true,
  }, snapshot);
  assert.equal(longSol.inputCostCents, 240);
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
