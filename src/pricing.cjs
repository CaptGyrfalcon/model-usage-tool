const DAY_MS = 86_400_000;
const codexAccounting = require("./codex-accounting.cjs");
const { billingUsdPricing } = require("./deepseek-usd.cjs");
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const CURSOR_PRICING_URL = "https://cursor.com/docs/models-and-pricing.md";
const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const DEVIN_PRICING_URL = "https://docs.devin.ai/desktop/models.md";

function tier(short, long = short) {
  return { short, long };
}

const FALLBACK_MODELS = {
  "gpt-6.1-sol": {
    provider: "openai",
    standard: tier(
      { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
      { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 },
    ),
    fast: tier(
      { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
      { input: 8, cacheRead: 0.4, cacheWrite: 10, output: 30 },
    ),
  },
  "gpt-6-sol": {
    provider: "openai",
    standard: tier(
      { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 15 },
    ),
    fast: tier(
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 },
    ),
  },
  "gpt-6-luna": {
    provider: "openai",
    standard: tier(
      { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
      { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
    ),
    fast: tier(
      { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1 },
      { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.5 },
    ),
  },
  "gpt-6-astra": {
    provider: "openai",
    standard: tier(
      { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
      { input: 20, cacheRead: 2, cacheWrite: 25, output: 75 },
    ),
    fast: tier(
      { input: 20, cacheRead: 2, cacheWrite: 25, output: 100 },
      { input: 40, cacheRead: 4, cacheWrite: 50, output: 150 },
    ),
  },
  "gpt-5.6-sol": {
    provider: "openai",
    standard: tier(
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 },
    ),
    fast: tier(
      { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 40 },
      { input: 16, cacheRead: 1.6, cacheWrite: 20, output: 60 },
    ),
  },
  "gpt-5.6-terra": {
    provider: "openai",
    standard: tier(
      { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 18 },
    ),
    fast: tier(
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 24 },
      { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 36 },
    ),
  },
  "gpt-5.6-luna": {
    provider: "openai",
    standard: tier(
      { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
      { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
    ),
    fast: tier(
      { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 2.4 },
      { input: 0.8, cacheRead: 0.08, cacheWrite: 1, output: 3.6 },
    ),
  },
  "grok-4.6": {
    provider: "cursor",
    standard: tier({ input: 2, cacheRead: 0.5, cacheWrite: 0, output: 6 }),
    fast: tier({ input: 4, cacheRead: 1, cacheWrite: 0, output: 12 }),
  },
  "grok-4.5": {
    provider: "cursor",
    standard: tier({ input: 2, cacheRead: 0.5, cacheWrite: 0, output: 6 }),
    fast: tier({ input: 4, cacheRead: 1, cacheWrite: 0, output: 18 }),
  },
  "grok-4.7": {
    provider: "cursor",
    standard: tier({ input: 2, cacheRead: 0.5, cacheWrite: 0, output: 6 }),
    fast: tier({ input: 4, cacheRead: 1, cacheWrite: 0, output: 12 }),
  },
  "grok-4.7-500k": {
    provider: "cursor",
    standard: tier({ input: 4, cacheRead: 1, cacheWrite: 0, output: 12 }),
    fast: tier({ input: 6, cacheRead: 1.5, cacheWrite: 0, output: 18 }),
  },
  "composer-2.5": {
    provider: "cursor",
    standard: tier({ input: 0.5, cacheRead: 0.2, cacheWrite: 0, output: 2.5 }),
    fast: tier({ input: 3, cacheRead: 0.5, cacheWrite: 0, output: 15 }),
  },
  "claude-fable-5": {
    provider: "cursor",
    standard: tier({ input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 }),
  },
  "claude-opus-5": {
    provider: "cursor",
    standard: tier({ input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 }),
  },
  "claude-sonnet-5": {
    provider: "cursor",
    standard: tier({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }),
  },
  "gemini-3.1-pro": {
    provider: "cursor",
    standard: tier({ input: 2, cacheRead: 0.2, cacheWrite: 0, output: 12 }),
  },
  "gemini-3.7-flash": {
    provider: "cursor",
    standard: tier({ input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.5 }),
  },
  "auto-cost": {
    provider: "cursor",
    standard: tier({ input: 1.25, cacheRead: 0.25, cacheWrite: 1.25, output: 6 }),
  },
};

const FALLBACK_CODEX_MODELS = Object.fromEntries(
  Object.entries(FALLBACK_MODELS).filter(([name]) => name.startsWith("gpt-")),
);
const FALLBACK_CURSOR_MODELS = {
  ...Object.fromEntries(Object.entries(FALLBACK_MODELS).filter(([name]) => !name.startsWith("gpt-"))),
  "gpt-6-astra": { provider: "cursor", standard: tier({ input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 }) },
  "gpt-5.6-sol": { provider: "cursor", standard: tier({ input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 }) },
  "gpt-5.6-terra": { provider: "cursor", standard: tier({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 }) },
  "gpt-5.6-luna": { provider: "cursor", standard: tier({ input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 }) },
};

// Anthropic first-party list prices for Claude Code. Cache writes are 1.25x
// input for the 5-minute TTL and 2x for the 1-hour TTL Claude Code uses.
function anthropicRate(input, output, cacheRead = input / 10) {
  return { input, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2, output };
}

const FALLBACK_CLAUDE_MODELS = {
  "claude-fable-5-1": { provider: "anthropic", standard: tier(anthropicRate(10, 50, 0.25)) },
  "claude-fable-5": { provider: "anthropic", standard: tier(anthropicRate(10, 50)) },
  "claude-opus-5-5": {
    provider: "anthropic",
    standard: tier(anthropicRate(4, 20, 0.2)),
    fast: tier(anthropicRate(8, 40, 0.4)),
  },
  "claude-opus-5": {
    provider: "anthropic",
    standard: tier(anthropicRate(5, 25)),
    fast: tier(anthropicRate(10, 50)),
  },
  "claude-opus-4-8": { provider: "anthropic", standard: tier(anthropicRate(5, 25)), fast: tier(anthropicRate(10, 50)) },
  "claude-opus-4-7": { provider: "anthropic", standard: tier(anthropicRate(5, 25)) },
  "claude-opus-4-6": { provider: "anthropic", standard: tier(anthropicRate(5, 25)) },
  "claude-sonnet-5-5": { provider: "anthropic", standard: tier(anthropicRate(2, 10)) },
  "claude-sonnet-5": { provider: "anthropic", standard: tier(anthropicRate(2, 10)) },
  "claude-sonnet-4-6": { provider: "anthropic", standard: tier(anthropicRate(3, 15)) },
  "claude-haiku-4-5": { provider: "anthropic", standard: tier(anthropicRate(1, 5)) },
};

// SWE-2 list price, independently of the temporary self-serve free offer.
// Source: docs.devin.ai/desktop/models, verified 2026-10-11. Cache writes
// have no separate published rate; value them as ordinary input for display.
const FALLBACK_DEVIN_MODELS = { ...FALLBACK_CODEX_MODELS, ...FALLBACK_CLAUDE_MODELS,
  "swe-2": { provider: "cognition", standard: tier({ input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 }),
    note: "SWE-2 官方原价等值；写缓存按输入价估算；额度使用服务端实际百分比" } };

function parseDevinListPricing(text) {
  const match = String(text).match(/list pric(?:ing|e)\s*\(\s*\$([\d.]+)\s*\/\s*1M\s+input\s*,\s*\$([\d.]+)\s*\/\s*1M\s+output\s*,\s*\$([\d.]+)\s*\/\s*1M\s+cache input\s*\)/i);
  if (!match) throw new Error("Devin 官方原价格式变化，保留已有原价");
  const [input, output, cacheRead] = match.slice(1).map(Number);
  if (![input, output, cacheRead].every(n => Number.isFinite(n) && n > 0)) throw new Error("Devin 官方原价无效");
  return { "swe-2": { ...FALLBACK_DEVIN_MODELS["swe-2"], standard: tier({ input, output, cacheRead, cacheWrite: input }) } };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeFallbackCatalog(snapshot, now = Date.now()) {
  const base = snapshot ? clone(snapshot) : builtInSnapshot(now);
  base.models = { ...clone(FALLBACK_MODELS), ...base.models };
  base.modelsBySource = {
    codex: { ...clone(FALLBACK_CODEX_MODELS), ...(base.modelsBySource?.codex || {}) },
    cursor: { ...clone(FALLBACK_CURSOR_MODELS), ...(base.modelsBySource?.cursor || {}) },
    claude: { ...clone(FALLBACK_CLAUDE_MODELS), ...(base.modelsBySource?.claude || {}) },
    devin: { ...clone(FALLBACK_DEVIN_MODELS),
      ...Object.fromEntries(Object.entries(base.models || {}).filter(([name]) => name.startsWith("gpt-"))),
      ...(base.modelsBySource?.claude || {}), ...(base.modelsBySource?.devin || {}) },
  };
  return base;
}

function catalogModel(snapshot, source, key) {
  return snapshot?.modelsBySource?.[source]?.[key] || snapshot?.models?.[key] || null;
}

function fallbackModel(source, key) {
  if (source === "devin") return FALLBACK_DEVIN_MODELS[key] || null;
  if (source === "claude") return FALLBACK_CLAUDE_MODELS[key] || null;
  if (source === "codex") return FALLBACK_CODEX_MODELS[key] || FALLBACK_MODELS[key] || null;
  return FALLBACK_CURSOR_MODELS[key] || FALLBACK_MODELS[key] || null;
}

function builtInSnapshot(now = Date.now()) {
  return {
    fetchedAt: now,
    status: "built-in",
    models: clone(FALLBACK_MODELS),
    modelsBySource: {
      codex: clone(FALLBACK_CODEX_MODELS),
      cursor: clone(FALLBACK_CURSOR_MODELS),
      claude: clone(FALLBACK_CLAUDE_MODELS),
      devin: clone(FALLBACK_DEVIN_MODELS),
    },
    sourceUrls: [OPENAI_PRICING_URL.replace(/\.md$/, ""), CURSOR_PRICING_URL.replace(/\.md$/, ""), ANTHROPIC_PRICING_URL, DEVIN_PRICING_URL.replace(/\.md$/, "")],
    note: "内置的最近一次官方价目表；联网更新失败时使用。",
  };
}

function money(value) {
  if (value == null || value === "-") return 0;
  const match = String(value).match(/\$\s*([\d.]+)/);
  return match ? Number(match[1]) : Number.NaN;
}

function tableCells(line) {
  return String(line).split("|").map((cell) => cell.replace(/[`*_]/g, "").trim()).filter(Boolean);
}

function parseOpenAiPricing(text, baseModels = FALLBACK_MODELS) {
  const models = clone(baseModels);
  text = String(text).replace(/<\/(?:td|th)>/gi, " | ").replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ");
  const nameOf = (cell) => cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim().toLowerCase();
  const tracked = new Set(Object.keys(models).filter((name) => name.startsWith("gpt-")));
  for (const line of text.split(/\r?\n/)) {
    const name = nameOf(tableCells(line)[0] || "");
    if (/^gpt-[a-z0-9.-]+$/.test(name)) tracked.add(name);
  }
  for (const model of tracked) {
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.toLowerCase().includes(model)) continue;
      const cells = tableCells(line);
      const index = cells.findIndex((cell) => nameOf(cell) === model);
      if (index < 0) continue;
      const values = cells.slice(index + 1, index + 9).map(money);
      if (values.length === 8 && values.every(Number.isFinite)) rows.push(values);
    }
    if (!rows.length) continue;
    const standard = rows[0];
    // Batch/Flex rows are cheaper; never mistake them for Fast pricing.
    const fast = rows.slice(1).findLast((row) => row[0] > standard[0] && row[3] > standard[3]);
    models[model] = {
      provider: "openai",
      standard: tier(
        { input: standard[0], cacheRead: standard[1], cacheWrite: standard[2], output: standard[3] },
        { input: standard[4], cacheRead: standard[5], cacheWrite: standard[6], output: standard[7] },
      ),
      ...(fast ? { fast: tier(
        { input: fast[0], cacheRead: fast[1], cacheWrite: fast[2], output: fast[3] },
        { input: fast[4], cacheRead: fast[5], cacheWrite: fast[6], output: fast[7] },
      ) } : {}),
    };
  }
  return models;
}

const CURSOR_NAMES = new Map([
  ["grok 4.7 500k (fast)", ["grok-4.7-500k", "fast"]],
  ["grok 4.7 500k", ["grok-4.7-500k", "standard"]],
  ["grok 4.7 (fast)", ["grok-4.7", "fast"]],
  ["grok 4.7", ["grok-4.7", "standard"]],
  ["grok 4.6 (fast)", ["grok-4.6", "fast"]],
  ["grok 4.6", ["grok-4.6", "standard"]],
  ["grok 4.5 (fast)", ["grok-4.5", "fast"]],
  ["grok 4.5", ["grok-4.5", "standard"]],
  ["composer 2.5 (fast)", ["composer-2.5", "fast"]],
  ["composer 2.5", ["composer-2.5", "standard"]],
  ["claude fable 5", ["claude-fable-5", "standard"]],
  ["claude opus 5", ["claude-opus-5", "standard"]],
  ["claude sonnet 5", ["claude-sonnet-5", "standard"]],
  ["gpt-6 astra (fast)", ["gpt-6-astra", "fast"]],
  ["gpt-6 astra", ["gpt-6-astra", "standard"]],
  ["gpt-6 sol (fast)", ["gpt-6-sol", "fast"]],
  ["gpt-6 sol", ["gpt-6-sol", "standard"]],
  ["gpt-6 luna (fast)", ["gpt-6-luna", "fast"]],
  ["gpt-6 luna", ["gpt-6-luna", "standard"]],
  ["gpt-5.6 luna", ["gpt-5.6-luna", "standard"]],
  ["gpt-5.6 sol", ["gpt-5.6-sol", "standard"]],
  ["gpt-5.6 terra", ["gpt-5.6-terra", "standard"]],
  ["gemini 3.1 pro", ["gemini-3.1-pro", "standard"]],
  ["gemini 3.7 flash", ["gemini-3.7-flash", "standard"]],
  ["auto cost", ["auto-cost", "standard"]],
]);

function cleanCursorName(cell) {
  return String(cell)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[^a-z0-9.() +_-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseCursorPricing(text, baseModels = FALLBACK_MODELS) {
  const models = clone(baseModels);
  const normalizedText = String(text)
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
  for (const line of normalizedText.split(/\r?\n/)) {
    const cells = tableCells(line);
    if (cells.length < 5) continue;
    const name = cleanCursorName(cells[0]);
    const match = [...CURSOR_NAMES.entries()].find(([label]) => name === label || name.endsWith(` ${label}`));
    if (!match) continue;
    const [model, speed] = match[1];
    const values = cells.slice(1, 5).map(money);
    if (!values.every(Number.isFinite)) continue;
    models[model] ||= { provider: "cursor" };
    models[model].provider = "cursor";
    models[model][speed] = tier({ input: values[0], cacheWrite: values[1], cacheRead: values[2], output: values[3] });
  }
  return models;
}

async function fetchText(url) {
  const request = (target) => fetch(target, { headers: { Accept: "text/markdown,text/plain;q=0.9,text/html;q=0.7,*/*;q=0.1" }, signal: AbortSignal.timeout(12_000) });
  let response = await request(url);
  if (!response.ok && url.endsWith(".md")) response = await request(url.slice(0, -3));
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  return response.text();
}

async function refreshPricing(history, { force = false, now = Date.now() } = {}) {
  const latest = history.latestPricingSnapshot?.() || null;
  const attempt = history.loadCache("pricing-last-attempt");
  if (!force && attempt && now - attempt.updatedAt < DAY_MS) {
    return { snapshot: mergeFallbackCatalog(latest || builtInSnapshot(now)), updated: false, nextCheckAt: attempt.updatedAt + DAY_MS };
  }
  history.saveCache("pricing-last-attempt", { at: now, force: Boolean(force) });
  const results = await Promise.allSettled([fetchText(OPENAI_PRICING_URL), fetchText(CURSOR_PRICING_URL), fetchText(DEVIN_PRICING_URL)]);
  const previous = mergeFallbackCatalog(latest);
  let codexModels = clone(previous.modelsBySource.codex);
  let cursorModels = clone(previous.modelsBySource.cursor);
  let devinModels = clone(previous.modelsBySource.devin);
  const errors = [];
  for (const [index, parser, label] of [[0, parseOpenAiPricing, "OpenAI"], [1, parseCursorPricing, "Cursor"]]) {
    try {
      if (results[index].status === "rejected") throw results[index].reason;
      const parsed = parser(results[index].value, {});
      if (!Object.keys(parsed).length) throw new Error(`${label} 价目表未解析到价格`);
      if (index === 0) codexModels = { ...codexModels, ...parsed };
      else cursorModels = { ...cursorModels, ...parsed };
    } catch (error) { errors.push(error?.message || `${label} 价目表更新失败`); }
  }
  try {
    if (results[2].status === "rejected") throw results[2].reason;
    devinModels = { ...devinModels, ...parseDevinListPricing(results[2].value) };
  } catch { errors.push("Devin 官方原价更新失败，保留已有原价"); }
  const snapshot = {
    fetchedAt: now,
    status: errors.length ? (errors.length === 3 ? "built-in" : "remote-partial") : "remote",
    models: { ...cursorModels, ...codexModels },
    modelsBySource: { codex: codexModels, cursor: cursorModels, claude: clone(previous.modelsBySource.claude),
      devin: { ...devinModels, ...codexModels, ...clone(previous.modelsBySource.claude) } },
    sourceUrls: [OPENAI_PRICING_URL.replace(/\.md$/, ""), CURSOR_PRICING_URL.replace(/\.md$/, ""), ANTHROPIC_PRICING_URL, DEVIN_PRICING_URL.replace(/\.md$/, "")],
    note: errors.length ? errors.join("；") : "已从 OpenAI、Cursor 与 Devin 官方文档更新。",
  };
  if (snapshot.status !== "built-in" || !latest) snapshot.id = history.savePricingSnapshot(snapshot);
  else snapshot.id = latest?.id || history.savePricingSnapshot(snapshot);
  const selected = snapshot.status === "built-in" && latest ? latest : snapshot;
  return { snapshot: mergeFallbackCatalog(selected), updated: snapshot.status !== "built-in", errors, nextCheckAt: now + DAY_MS };
}

function modelKey(raw) {
  let value = String(raw || "unknown").toLowerCase().replace(/^cursor-/, "");
  value = value.replace(/-(?:minimal|low|medium|high|xhigh|max|ultra)(?=-fast$|$)/, "").replace(/-fast$/, "");
  if (value === "gpt-6" || value === "gpt-6-astra") return "gpt-6-astra";
  if (value === "gpt-5.6") return "gpt-5.6-sol";
  if (value.startsWith("claude-fable-5")) return "claude-fable-5";
  if (value.startsWith("claude-opus-5")) return "claude-opus-5";
  if (value.startsWith("claude-sonnet-5")) return "claude-sonnet-5";
  return value;
}

// Claude Code model IDs keep their minor version (Opus 5.5 is not priced like
// Opus 5), and may carry a date snapshot or a "[1m]" context suffix.
function claudeModelKey(raw, catalog = FALLBACK_CLAUDE_MODELS) {
  const value = String(raw || "unknown").toLowerCase()
    .replace(/^(?:anthropic\.|us\.anthropic\.)/, "").replace(/\[[^\]]*\]$/, "")
    .replace(/-(?:\d{8}|v\d+(?::\d+)?)$/, "").replace(/-fast$/, "");
  if (catalog[value]) return value;
  const prefix = Object.keys(catalog)
    .filter((key) => value.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix || value;
}

function components(event, rate) {
  const factor = 100 / 1_000_000;
  const cacheReadCostCents = Math.max(0, Number(event.cacheRead) || 0) * rate.cacheRead * factor;
  const cacheWrite = Math.max(0, Number(event.cacheWrite) || 0);
  const cacheWrite1h = Math.min(cacheWrite, Math.max(0, Number(event.cacheWrite1h) || 0));
  const cacheWriteCostCents = ((cacheWrite - cacheWrite1h) * rate.cacheWrite
    + cacheWrite1h * (rate.cacheWrite1h ?? rate.cacheWrite)) * factor;
  return {
    inputCostCents: Math.max(0, Number(event.input) || 0) * rate.input * factor,
    cacheReadCostCents,
    cacheWriteCostCents,
    cacheCostCents: cacheReadCostCents + cacheWriteCostCents,
    outputCostCents: Math.max(0, Number(event.output) || 0) * rate.output * factor,
  };
}

function totalCost(parts) {
  return parts.inputCostCents + parts.cacheCostCents + parts.outputCostCents;
}

function multiplyComponents(parts, multiplier) {
  return {
    inputCostCents: parts.inputCostCents * multiplier,
    cacheReadCostCents: parts.cacheReadCostCents * multiplier,
    cacheWriteCostCents: parts.cacheWriteCostCents * multiplier,
    cacheCostCents: parts.cacheCostCents * multiplier,
    outputCostCents: parts.outputCostCents * multiplier,
  };
}

function codexFastCreditMultiplier(event) {
  if (String(event?.source || "").toLowerCase() !== "codex") return 1;
  const key = modelKey(event?.model);
  if (codexAccounting.RATES[key]) return codexAccounting.fastMultiplier(key);
  if (/^gpt-5\.4(?:-|$)/.test(key)) return 2;
  if (/^gpt-6(?:-|$)/.test(key) || /^gpt-5\.(?:5|6)(?:-|$)/.test(key)) return 2.5;
  return 1;
}

function scaleComponents(parts, total) {
  const calculated = totalCost(parts);
  if (!Number.isFinite(total) || total < 0 || calculated <= 0) return parts;
  const scale = total / calculated;
  return {
    inputCostCents: parts.inputCostCents * scale,
    cacheReadCostCents: parts.cacheReadCostCents * scale,
    cacheWriteCostCents: parts.cacheWriteCostCents * scale,
    cacheCostCents: parts.cacheCostCents * scale,
    outputCostCents: parts.outputCostCents * scale,
  };
}

function priceEvent(event, snapshot, { authoritativeTotalCents = null, authoritativeSource = "model-total", fallbackSnapshot = null } = {}) {
  const source = String(event.source || "").toLowerCase();
  if (source === "deepseek") {
    const billing = billingUsdPricing(event);
    if (billing) return billing;
  }
  const key = source === "claude" || (source === "devin" && /^claude-/i.test(event.model))
    ? claudeModelKey(event.model, { ...FALLBACK_CLAUDE_MODELS, ...(snapshot?.modelsBySource?.claude || {}) })
    : modelKey(source === "devin" ? String(event.model).replace(/-(ultra|max|xhigh|high|medium|low|minimal|none)$/, "") : event.model);
  // User-selected accounting assumption, not an official published rate.
  // Token updates are retained; a separate, stable completed-turn event carries the fee.
  if (source === "codex" && String(event.model || "").toLowerCase() === "codex-auto-review") {
    const fee = String(event.eventKey || "").startsWith("codex:review-turn:") ? 1 : 0;
    return {
      inputCostCents: 0, cacheReadCostCents: 0, cacheWriteCostCents: 0,
      cacheCostCents: 0, outputCostCents: 0, reviewCostCents: fee,
      equivalentCostCents: fee, equivalentCostLowCents: fee, equivalentCostHighCents: fee,
      quotaEquivalentCostCents: fee, quotaEquivalentCostLowCents: fee, quotaEquivalentCostHighCents: fee,
      pricingSnapshotId: snapshot?.id || null,
      pricingStatus: `${codexAccounting.VERSION}-${fee ? "review-turn" : "review-token-only"}`,
    };
  }
  // Without a matched bill, Harness Token usage does not identify actual fees.
  const model = source === "deepseek" ? null : (source === "codex" ? codexAccounting.model(key) : null) || catalogModel(snapshot, source, key)
    || catalogModel(fallbackSnapshot, source, key)
    || fallbackModel(source, key);
  if (!model?.standard) {
    const authoritative = authoritativeTotalCents == null ? null : Number(authoritativeTotalCents);
    if (source === "cursor" && Number.isFinite(authoritative) && authoritative >= 0) {
      // Auto can be reported as "default" without the routed model. The
      // server's model total is usable even though its parts cannot be priced.
      return {
        equivalentCostCents: authoritative,
        equivalentCostLowCents: authoritative,
        equivalentCostHighCents: authoritative,
        quotaEquivalentCostCents: authoritative,
        quotaEquivalentCostLowCents: authoritative,
        quotaEquivalentCostHighCents: authoritative,
        inputCostCents: null,
        cacheReadCostCents: null,
        cacheWriteCostCents: null,
        cacheCostCents: null,
        outputCostCents: null,
        pricingSnapshotId: snapshot?.id || null,
        pricingStatus: authoritativeSource === "charged-total" ? "charged-total-unallocated" : "api-total-unallocated",
      };
    }
    return {
      equivalentCostCents: null,
      equivalentCostLowCents: null,
      equivalentCostHighCents: null,
      quotaEquivalentCostCents: null,
      quotaEquivalentCostLowCents: null,
      quotaEquivalentCostHighCents: null,
      inputCostCents: null,
      cacheReadCostCents: null,
      cacheWriteCostCents: null,
      cacheCostCents: null,
      outputCostCents: null,
      pricingSnapshotId: snapshot?.id || null,
      pricingStatus: "unavailable",
    };
  }
  const rawInput = (Number(event.input) || 0) + (Number(event.cacheRead) || 0) + (Number(event.cacheWrite) || 0);
  const isCodex = String(event.source || "").toLowerCase() === "codex";
  const skipLongContext = isCodex && /^gpt-6(?:-|$)/.test(key);
  const context = !skipLongContext && rawInput > 272_000 ? "long" : "short";
  const knownFast = event.fastKnown !== false;
  const standard = components(event, model.standard[context] || model.standard.short);
  const creditMultiplier = codexFastCreditMultiplier(event);
  const creditFast = multiplyComponents(standard, creditMultiplier);
  const apiFast = model.fast ? components(event, model.fast[context] || model.fast.short) : standard;
  let selected = isCodex
    ? knownFast && event.fast ? creditFast : standard
    : knownFast && event.fast ? apiFast : standard;
  // Unknown tier is accounted as non-fast by user preference. Preserve the
  // original tier evidence; only the accounting assumption changes.
  let low = selected;
  let high = selected;
  const authoritative = authoritativeTotalCents == null ? null : Number(authoritativeTotalCents);
  if (Number.isFinite(authoritative) && authoritative >= 0) {
    selected = scaleComponents(selected, authoritative);
    low = selected;
    high = selected;
  } else if (knownFast) {
    low = selected;
    high = selected;
  }
  const quotaSelected = totalCost(selected);
  const quotaLow = totalCost(low);
  const quotaHigh = totalCost(high);
  return {
    ...selected,
    equivalentCostCents: totalCost(selected),
    equivalentCostLowCents: totalCost(low),
    equivalentCostHighCents: totalCost(high),
    quotaEquivalentCostCents: source === "devin" ? null : quotaSelected,
    quotaEquivalentCostLowCents: source === "devin" ? null : quotaLow,
    quotaEquivalentCostHighCents: source === "devin" ? null : quotaHigh,
    pricingSnapshotId: snapshot?.id || null,
    pricingStatus: Number.isFinite(authoritative)
      ? "api-total-allocated"
      : isCodex
        ? `${key === "gpt-6.1-sol" ? codexAccounting.GPT61_VERSION : codexAccounting.model(key) ? codexAccounting.VERSION : "official-standard-rate-credit-multiplier"}${knownFast ? "" : "-tier-unknown"}`
        : knownFast ? "official-rate" : "official-rate-tier-unknown",
  };
}

module.exports = {
  OPENAI_PRICING_URL,
  CURSOR_PRICING_URL,
  ANTHROPIC_PRICING_URL,
  FALLBACK_MODELS,
  FALLBACK_CLAUDE_MODELS,
  builtInSnapshot,
  parseOpenAiPricing,
  parseCursorPricing,
  refreshPricing,
  parseDevinListPricing,
  mergeFallbackCatalog,
  modelKey,
  claudeModelKey,
  catalogModel,
  codexFastCreditMultiplier,
  priceEvent,
};
