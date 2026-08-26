const DAY_MS = 86_400_000;
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const CURSOR_PRICING_URL = "https://cursor.com/docs/models-and-pricing.md";

function tier(short, long = short) {
  return { short, long };
}

const FALLBACK_MODELS = {
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
  "gpt-5.6-sol": { provider: "cursor", standard: tier({ input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 }) },
  "gpt-5.6-terra": { provider: "cursor", standard: tier({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 }) },
  "gpt-5.6-luna": { provider: "cursor", standard: tier({ input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 }) },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function builtInSnapshot(now = Date.now()) {
  return {
    fetchedAt: now,
    status: "built-in",
    models: clone(FALLBACK_MODELS),
    modelsBySource: {
      codex: clone(FALLBACK_CODEX_MODELS),
      cursor: clone(FALLBACK_CURSOR_MODELS),
    },
    sourceUrls: [OPENAI_PRICING_URL.replace(/\.md$/, ""), CURSOR_PRICING_URL.replace(/\.md$/, "")],
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
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.toLowerCase().includes(model)) continue;
      const cells = tableCells(line);
      const index = cells.findIndex((cell) => cell.toLowerCase().includes(model));
      if (index < 0) continue;
      const values = cells.slice(index + 1, index + 9).map(money);
      if (values.length === 8 && values.every(Number.isFinite)) rows.push(values);
    }
    if (rows.length < 2) continue;
    const standard = rows[0];
    const fast = rows.at(-1);
    models[model] = {
      provider: "openai",
      standard: tier(
        { input: standard[0], cacheRead: standard[1], cacheWrite: standard[2], output: standard[3] },
        { input: standard[4], cacheRead: standard[5], cacheWrite: standard[6], output: standard[7] },
      ),
      fast: tier(
        { input: fast[0], cacheRead: fast[1], cacheWrite: fast[2], output: fast[3] },
        { input: fast[4], cacheRead: fast[5], cacheWrite: fast[6], output: fast[7] },
      ),
    };
  }
  return models;
}

const CURSOR_NAMES = new Map([
  ["grok 4.6 (fast)", ["grok-4.6", "fast"]],
  ["grok 4.6", ["grok-4.6", "standard"]],
  ["grok 4.5 (fast)", ["grok-4.5", "fast"]],
  ["grok 4.5", ["grok-4.5", "standard"]],
  ["composer 2.5 (fast)", ["composer-2.5", "fast"]],
  ["composer 2.5", ["composer-2.5", "standard"]],
  ["claude fable 5", ["claude-fable-5", "standard"]],
  ["claude opus 5", ["claude-opus-5", "standard"]],
  ["claude sonnet 5", ["claude-sonnet-5", "standard"]],
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
    const match = [...CURSOR_NAMES.entries()].find(([label]) => name.includes(label));
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
    return { snapshot: latest || builtInSnapshot(now), updated: false, nextCheckAt: attempt.updatedAt + DAY_MS };
  }
  history.saveCache("pricing-last-attempt", { at: now, force: Boolean(force) });
  const results = await Promise.allSettled([fetchText(OPENAI_PRICING_URL), fetchText(CURSOR_PRICING_URL)]);
  let codexModels = clone(FALLBACK_CODEX_MODELS);
  let cursorModels = clone(FALLBACK_CURSOR_MODELS);
  const errors = [];
  if (results[0].status === "fulfilled") codexModels = parseOpenAiPricing(results[0].value, codexModels);
  else errors.push(results[0].reason?.message || "OpenAI 价目表更新失败");
  if (results[1].status === "fulfilled") cursorModels = parseCursorPricing(results[1].value, cursorModels);
  else errors.push(results[1].reason?.message || "Cursor 价目表更新失败");
  const snapshot = {
    fetchedAt: now,
    status: errors.length ? (errors.length === 2 ? "built-in" : "remote-partial") : "remote",
    models: { ...cursorModels, ...codexModels },
    modelsBySource: { codex: codexModels, cursor: cursorModels },
    sourceUrls: [OPENAI_PRICING_URL.replace(/\.md$/, ""), CURSOR_PRICING_URL.replace(/\.md$/, "")],
    note: errors.length ? errors.join("；") : "已从 OpenAI 与 Cursor 官方文档更新。",
  };
  if (snapshot.status !== "built-in" || !latest) snapshot.id = history.savePricingSnapshot(snapshot);
  else snapshot.id = latest?.id || history.savePricingSnapshot(snapshot);
  return { snapshot: snapshot.status === "built-in" && latest ? latest : snapshot, updated: snapshot.status !== "built-in", nextCheckAt: now + DAY_MS };
}

function modelKey(raw) {
  let value = String(raw || "unknown").toLowerCase().replace(/^cursor-/, "");
  value = value.replace(/-(?:minimal|low|medium|high|xhigh|max|ultra)(?=-fast$|$)/, "").replace(/-fast$/, "");
  if (value === "gpt-5.6") return "gpt-5.6-sol";
  if (value.startsWith("claude-fable-5")) return "claude-fable-5";
  if (value.startsWith("claude-opus-5")) return "claude-opus-5";
  if (value.startsWith("claude-sonnet-5")) return "claude-sonnet-5";
  return value;
}

function components(event, rate) {
  const factor = 100 / 1_000_000;
  const cacheReadCostCents = Math.max(0, Number(event.cacheRead) || 0) * rate.cacheRead * factor;
  const cacheWriteCostCents = Math.max(0, Number(event.cacheWrite) || 0) * rate.cacheWrite * factor;
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
  if (/^gpt-5\.4(?:-|$)/.test(key)) return 2;
  if (/^gpt-5\.(?:5|6)(?:-|$)/.test(key)) return 2.5;
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

function priceEvent(event, snapshot, { authoritativeTotalCents = null } = {}) {
  const key = modelKey(event.model);
  const source = String(event.source || "").toLowerCase();
  const model = snapshot?.modelsBySource?.[source]?.[key] || snapshot?.models?.[key];
  if (!model?.standard) {
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
  const context = rawInput > 272_000 ? "long" : "short";
  const knownFast = event.fastKnown !== false;
  const standard = components(event, model.standard[context] || model.standard.short);
  const isCodex = String(event.source || "").toLowerCase() === "codex";
  const creditMultiplier = codexFastCreditMultiplier(event);
  const creditFast = multiplyComponents(standard, creditMultiplier);
  const apiFast = model.fast ? components(event, model.fast[context] || model.fast.short) : standard;
  let selected = isCodex
    ? knownFast && event.fast ? creditFast : standard
    : knownFast && event.fast ? apiFast : standard;
  let low = standard;
  let high = isCodex ? creditFast : apiFast;
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
    quotaEquivalentCostCents: quotaSelected,
    quotaEquivalentCostLowCents: quotaLow,
    quotaEquivalentCostHighCents: quotaHigh,
    pricingSnapshotId: snapshot?.id || null,
    pricingStatus: Number.isFinite(authoritative)
      ? "api-total-allocated"
      : isCodex
        ? knownFast ? "official-standard-rate-credit-multiplier" : "official-standard-rate-credit-multiplier-tier-unknown"
        : knownFast ? "official-rate" : "official-rate-tier-unknown",
  };
}

module.exports = {
  OPENAI_PRICING_URL,
  CURSOR_PRICING_URL,
  FALLBACK_MODELS,
  builtInSnapshot,
  parseOpenAiPricing,
  parseCursorPricing,
  refreshPricing,
  modelKey,
  codexFastCreditMultiplier,
  priceEvent,
};
