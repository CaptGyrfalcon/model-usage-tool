const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getHistory } = require("./history.cjs");
const { scanCodexUsage, codexPlanName } = require("./codex.cjs");
const { refreshPricing, priceEvent, mergeFallbackCatalog } = require("./pricing.cjs");
const { cursorEventKey } = require("./identity.cjs");
const { buildQuotaInsights } = require("./quota-insights.cjs");
const { buildQuotaTimeline, livePointsFromSnapshot } = require("./quota-timeline.cjs");
const { buildCodexMonthly, monthBounds, WEEK_MS } = require("./renderer/codex-monthly.js");
const { flattenPricingSnapshot, summarizePricingSnapshot } = require("./pricing-table.cjs");

const APP_DIR = path.join(os.homedir(), "AppData", "Roaming", "cursor-usage-widget");
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const SESSION_PATH = path.join(APP_DIR, "session.json");
const OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DAY_MS = 86_400_000;
const MODEL_RANGE_SPECS = {
  all: { label: "全部历史", durationMs: null },
  months6: { label: "近 6 个月", durationMs: 180 * DAY_MS },
  months3: { label: "近 3 个月", durationMs: 90 * DAY_MS },
  month1: { label: "近 1 个月", durationMs: 30 * DAY_MS },
  days14: { label: "近 14 天", durationMs: 14 * DAY_MS },
  days7: { label: "近 7 天", durationMs: 7 * DAY_MS },
  day1: { label: "近 1 天", durationMs: DAY_MS },
  hours12: { label: "近 12 小时", durationMs: 12 * 3_600_000 },
  hours6: { label: "近 6 小时", durationMs: 6 * 3_600_000 },
  hour1: { label: "近 1 小时", durationMs: 3_600_000 },
};
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const DEFAULT_SETTINGS = {
  opacity: 0.96,
  alwaysOnTop: true,
  compact: false,
  orbMode: false,
  orbPool: "cursor-models",
  orbDisplayMode: "quota",
  orbPoolShape: "sphere",
  orbPoolCombined: false,
  intervalMs: 30_000,
  x: null,
  y: null,
  openAtLogin: false,
  activeTab: "overview",
  modelRange: "month1",
  modelPrecision: "coarse",
  modelView: "list",
  modelMetric: "total",
  trendRange: "day",
  trendMetric: "total",
  trendBreakdown: false,
  trendSpeedBreakdown: false,
  dataSource: "all",
  quotaLevelPool: "cursor-models",
  eventSource: "all",
  pricingSource: "all",
  tokenDisplayVersion: 2,
  smartDock: false, // WIP: 智能贴边有严重 bug，入口已关闭。
  privacyMode: false,
  motionPreference: "system",
  quotaAlerts: false, // WIP: 额度提醒有严重 bug，入口已关闭。
  alertThreshold: 20, // WIP: 提醒阈值有严重 bug，入口已关闭。
};

let usageEventCache = [];
let usageCacheScope = null;
let usageCachePrimed = false;

function ensureAppDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureAppDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    // First launch uses defaults.
  }
  const next = { ...DEFAULT_SETTINGS, ...raw };
  // WIP: 智能贴边、额度提醒有严重 bug，入口已关闭，忽略本地已保存的开启状态。
  next.smartDock = false;
  next.quotaAlerts = false;
  if (raw.tokenDisplayVersion !== 2) {
    if (!raw.trendMetric || raw.trendMetric === "effective") next.trendMetric = "total";
    next.tokenDisplayVersion = 2;
    if (fs.existsSync(SETTINGS_PATH)) writeJson(SETTINGS_PATH, next);
  }
  return next;
}

function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  writeJson(SETTINGS_PATH, next);
  return next;
}

function stateDbPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb"
  );
}

function decodeJwt(token) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
}

function readCursorAuth() {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) throw new Error("未找到 Cursor 登录数据。请先在 Cursor 里登录账号。");
  const tmp = path.join(os.tmpdir(), `cursor-usage-state-${process.pid}.vscdb`);
  fs.copyFileSync(dbPath, tmp);
  let accessToken;
  let refreshToken;
  let email;
  let membership;
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    const get = (key) => {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
      return row ? String(row.value) : null;
    };
    accessToken = get("cursorAuth/accessToken");
    refreshToken = get("cursorAuth/refreshToken");
    email = get("cursorAuth/cachedEmail");
    membership = get("cursorAuth/stripeMembershipType");
    db.close();
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The copied database is disposable and replaced next refresh.
    }
  }
  if (!accessToken) throw new Error("Cursor 本地状态里没有 accessToken，请重新登录 Cursor。");
  return { accessToken, refreshToken, email, membership };
}

async function refreshAccessToken(refreshToken) {
  const resp = await fetch("https://api2.cursor.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: OAUTH_CLIENT_ID, refresh_token: refreshToken }),
  });
  const data = await resp.json();
  if (!data?.access_token) throw new Error("会话已过期，请重新登录 Cursor。");
  writeJson(SESSION_PATH, { accessToken: data.access_token, refreshedAt: Date.now() });
  return data.access_token;
}

async function resolveAuth() {
  const local = readCursorAuth();
  let accessToken = local.accessToken;
  try {
    const claims = decodeJwt(accessToken);
    const expMs = (claims.exp || 0) * 1000;
    if (expMs && expMs < Date.now() + 60_000 && local.refreshToken) accessToken = await refreshAccessToken(local.refreshToken);
  } catch (err) {
    const cached = readJson(SESSION_PATH, null);
    if (cached?.accessToken) accessToken = cached.accessToken;
    else throw err;
  }
  const claims = decodeJwt(accessToken);
  const sub = String(claims.sub || "");
  const userKey = sub.includes("|") ? sub.split("|").pop() : sub;
  return {
    accessToken,
    cookie: `${userKey}%3A%3A${accessToken}`,
    email: local.email,
    membership: local.membership,
  };
}

async function cursorFetch(auth, method, url, body, bearer = false) {
  const headers = { "User-Agent": BROWSER_UA, Origin: "https://cursor.com", Referer: "https://cursor.com/dashboard" };
  if (bearer) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
    headers["Connect-Protocol-Version"] = "1";
    headers["Content-Type"] = "application/json";
  } else {
    headers.Cookie = `WorkosCursorSessionToken=${auth.cookie}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`Cursor API ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

function num(value) {
  if (value == null || value === "" || value === "-") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function finitePercent(value) {
  if (value == null || value === "" || value === "-") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentPrecision(value) {
  const number = finitePercent(value);
  if (number == null) return -1;
  if (typeof value === "string" && /e/i.test(value) === false && value.includes(".")) {
    return value.split(".")[1].replace(/0+$/, "").length;
  }
  const text = String(number);
  if (/e/i.test(text)) {
    const [coefficient, exponent] = text.toLowerCase().split("e");
    return Math.max(0, (coefficient.split(".")[1] || "").length - Number(exponent));
  }
  return (text.split(".")[1] || "").length;
}

function pickUsagePercent(...candidates) {
  const scored = candidates
    .map((value) => ({ value: finitePercent(value), precision: percentPrecision(value) }))
    .filter((item) => item.value != null);
  if (!scored.length) return 0;
  scored.sort((left, right) => right.precision - left.precision);
  return scored[0].value;
}

function parseIsoOrMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const s = String(value);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isCursorModel(name, autoBucketModels) {
  const id = String(name || "").toLowerCase();
  if ((autoBucketModels || []).some((m) => String(m).toLowerCase() === id)) return true;
  return /^(composer|cursor-grok|grok-4|vega|default)/i.test(id);
}

function sumTokens(row) {
  return {
    input: num(row.inputTokens ?? row.totalInputTokens),
    output: num(row.outputTokens ?? row.totalOutputTokens),
    cacheRead: num(row.cacheReadTokens ?? row.totalCacheReadTokens),
    cacheWrite: num(row.cacheWriteTokens ?? row.totalCacheWriteTokens),
  };
}

function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function decorateTokens(t) {
  return { ...t, effective: t.input + t.output, total: t.input + t.output + t.cacheRead + t.cacheWrite };
}

function eventTokens(event) {
  if (event && ("input" in event || "output" in event || "cacheRead" in event || "cacheWrite" in event)) {
    return {
      input: num(event.input),
      output: num(event.output),
      cacheRead: num(event.cacheRead),
      cacheWrite: num(event.cacheWrite),
    };
  }
  const tu = event.tokenUsage || {};
  return {
    input: num(tu.inputTokens),
    output: num(tu.outputTokens),
    cacheRead: num(tu.cacheReadTokens),
    cacheWrite: num(tu.cacheWriteTokens),
  };
}

function eventCostCents(event) {
  return num(event.costCents ?? event.chargedCents ?? event.tokenUsage?.totalCents ?? event.usageBasedCosts);
}

function eventEquivalentCostCents(event) {
  const value = event.equivalentCostCents ?? event.tokenUsage?.totalCents ?? event.costCents ?? event.chargedCents;
  return value == null ? 0 : num(value);
}

function costSummary(events) {
  const summary = {
    equivalentCostCents: 0,
    equivalentCostLowCents: 0,
    equivalentCostHighCents: 0,
    inputCostCents: 0,
    cacheReadCostCents: 0,
    cacheWriteCostCents: 0,
    cacheCostCents: 0,
    outputCostCents: 0,
    pricedEvents: 0,
    totalEvents: events.length,
  };
  for (const event of events) {
    if (event.equivalentCostCents == null) continue;
    summary.pricedEvents += 1;
    summary.equivalentCostCents += num(event.equivalentCostCents);
    summary.equivalentCostLowCents += num(event.equivalentCostLowCents ?? event.equivalentCostCents);
    summary.equivalentCostHighCents += num(event.equivalentCostHighCents ?? event.equivalentCostCents);
    summary.inputCostCents += num(event.inputCostCents);
    summary.cacheReadCostCents += num(event.cacheReadCostCents);
    summary.cacheWriteCostCents += num(event.cacheWriteCostCents);
    summary.cacheCostCents += num(event.cacheCostCents);
    summary.outputCostCents += num(event.outputCostCents);
  }
  summary.coveragePercent = summary.totalEvents ? summary.pricedEvents / summary.totalEvents * 100 : 100;
  return summary;
}

function quotaCostSummary(events) {
  events = events.filter((event) => event.source !== "codex" || !/spark/i.test(event.model || ""));
  const summary = {
    equivalentCostCents: 0,
    equivalentCostLowCents: 0,
    equivalentCostHighCents: 0,
    pricedEvents: 0,
    totalEvents: events.length,
  };
  for (const event of events) {
    if (event.quotaEquivalentCostCents == null) continue;
    summary.pricedEvents += 1;
    summary.equivalentCostCents += num(event.quotaEquivalentCostCents);
    summary.equivalentCostLowCents += num(event.quotaEquivalentCostLowCents ?? event.quotaEquivalentCostCents);
    summary.equivalentCostHighCents += num(event.quotaEquivalentCostHighCents ?? event.quotaEquivalentCostCents);
  }
  summary.coveragePercent = summary.totalEvents ? summary.pricedEvents / summary.totalEvents * 100 : 100;
  return summary;
}

function speedUsageSummary(events, { quota = false } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const costKey = quota ? "quotaEquivalentCostCents" : "equivalentCostCents";
  const allPriced = rows.length > 0 && rows.every((event) => event[costKey] != null);
  const result = { normal: 0, fast: 0, unknown: 0, basis: allPriced ? "equivalent-cost" : "tokens" };
  for (const event of rows) {
    const tokens = eventTokens(event);
    const weight = allPriced
      ? Math.max(0, num(event[costKey]))
      : Math.max(0, tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite);
    const bucket = event.fastKnown === false ? "unknown" : event.fast ? "fast" : "normal";
    result[bucket] += weight;
  }
  result.total = result.normal + result.fast + result.unknown;
  return result;
}

function inferPoolQuota(costs, percentUsed, officialLimitCents = null) {
  const ratio = Number(percentUsed) > 0 ? Number(percentUsed) / 100 : null;
  const usedCents = num(costs?.equivalentCostCents);
  const inferredTotalCents = ratio ? usedCents / ratio : null;
  const official = Number(officialLimitCents) > 0 ? Number(officialLimitCents) : null;
  return {
    usedCents,
    inferredTotalCents,
    inferredRemainingCents: inferredTotalCents == null ? null : Math.max(0, inferredTotalCents - usedCents),
    packageTotalCents: official ?? inferredTotalCents,
    packageTotalSource: official == null ? "usage-percent" : "cursor-api",
  };
}

function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysLeft(endMs) {
  if (!endMs) return null;
  return Math.max(0, Math.ceil((endMs - Date.now()) / DAY_MS));
}

function normalizeModelDescriptor(rawName) {
  const original = String(rawName || "unknown");
  let clean = original.replace(/^cursor-/i, "");
  const parts = clean.split("-").filter(Boolean);
  let fast = false;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase() === "fast") {
      fast = true;
      parts.splice(i, 1);
    }
  }
  let effort = null;
  if (parts.length && EFFORT_LEVELS.has(parts[parts.length - 1].toLowerCase())) effort = parts.pop().toLowerCase();
  const base = parts.join("-") || clean || "unknown";
  clean = base + (effort ? `-${effort}` : "") + (fast ? "-fast" : "");
  return { original, clean, base, fast, effort };
}

function modelLabel(descriptor, precision) {
  if (precision === "coarse") return descriptor.base;
  if (precision === "speed") return `${descriptor.base} · ${descriptor.fast ? "Fast" : "标准"}`;
  return `${descriptor.base} · ${descriptor.effort || "默认"} · ${descriptor.fast ? "Fast" : "标准"}`;
}

function buildModelBreakdown(events, precision, autoBucketModels = []) {
  const groups = new Map();
  for (const event of events) {
    const descriptor = normalizeModelDescriptor(event.model);
    if (event.effort != null) descriptor.effort = String(event.effort);
    if ("fast" in event) descriptor.fast = Boolean(event.fast);
    descriptor.fastKnown = event.fastKnown !== false;
    const key = precision === "coarse"
      ? descriptor.base
      : precision === "speed"
        ? `${descriptor.base}|${descriptor.fastKnown ? (descriptor.fast ? "fast" : "standard") : "unknown"}`
        : `${descriptor.base}|${descriptor.effort || "default"}|${descriptor.fastKnown ? (descriptor.fast ? "fast" : "standard") : "unknown"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: descriptor.base,
        label: descriptor.fastKnown
          ? modelLabel(descriptor, precision)
          : precision === "coarse"
            ? descriptor.base
            : precision === "speed"
              ? `${descriptor.base} · 速度未知`
              : `${descriptor.base} · ${descriptor.effort || "默认"} · 速度未知`,
        fast: descriptor.fast,
        fastKnown: descriptor.fastKnown,
        effort: descriptor.effort,
        count: 0,
        reasoning: 0,
        costCents: 0,
        inputCostCents: 0,
        cacheReadCostCents: 0,
        cacheWriteCostCents: 0,
        outputCostCents: 0,
        tokens: emptyTokens(),
        cursor: isCursorModel(event.model, autoBucketModels),
      });
    }
    const group = groups.get(key);
    group.count += Math.max(1, num(event.count) || 1);
    group.reasoning += Math.max(0, num(event.reasoning));
    group.costCents += eventEquivalentCostCents(event);
    group.inputCostCents += num(event.inputCostCents);
    group.cacheReadCostCents += num(event.cacheReadCostCents);
    group.cacheWriteCostCents += num(event.cacheWriteCostCents);
    group.outputCostCents += num(event.outputCostCents);
    group.tokens = addTokens(group.tokens, eventTokens(event));
  }
  return [...groups.values()]
    .map((group) => ({ ...group, ...decorateTokens(group.tokens), tokens: undefined }))
    .sort((a, b) => b.total - a.total || b.effective - a.effective || b.costCents - a.costCents);
}

function buildModelBreakdowns(events, autoBucketModels = []) {
  return {
    coarse: buildModelBreakdown(events, "coarse", autoBucketModels),
    speed: buildModelBreakdown(events, "speed", autoBucketModels),
    exact: buildModelBreakdown(events, "exact", autoBucketModels),
  };
}

function addLocalDays(timestamp, days) {
  const d = new Date(timestamp);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function makeTrendBoundaries(range, now) {
  const dayStart = startOfLocalDay(now);
  if (range === "day") {
    const boundaries = [];
    for (let i = 0; i <= 24; i += 1) {
      const d = new Date(dayStart);
      d.setHours(i, 0, 0, 0);
      boundaries.push(d.getTime());
    }
    return boundaries;
  }
  const count = range === "week" ? 7 : 30;
  const first = addLocalDays(dayStart, -(count - 1));
  return Array.from({ length: count + 1 }, (_unused, i) => addLocalDays(first, i));
}

function emptyTrendSlice() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    effective: 0,
    total: 0,
    equivalentCostCents: 0,
    inputCostCents: 0,
    cacheReadCostCents: 0,
    cacheWriteCostCents: 0,
    cacheCostCents: 0,
    outputCostCents: 0,
  };
}

function eventSpeedKey(event) {
  return event?.fast && event?.fastKnown !== false ? "fast" : "normal";
}

function addTrendSlice(target, tokens, event) {
  const cost = eventEquivalentCostCents(event);
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.effective += tokens.effective;
  target.total += tokens.total;
  target.equivalentCostCents += cost;
  target.inputCostCents += num(event.inputCostCents);
  target.cacheReadCostCents += num(event.cacheReadCostCents);
  target.cacheWriteCostCents += num(event.cacheWriteCostCents);
  target.cacheCostCents += num(event.cacheCostCents);
  target.outputCostCents += num(event.outputCostCents);
  if ("costCents" in target) target.costCents += cost;
}

function buildTrendSeries(events, range, now = Date.now()) {
  const boundaries = makeTrendBoundaries(range, now);
  const buckets = boundaries.slice(0, -1).map((start, index) => {
    const d = new Date(start);
    const isDay = range === "day";
    return {
      start,
      end: boundaries[index + 1],
      label: isDay
        ? `${String(d.getHours()).padStart(2, "0")}:00–${String((d.getHours() + 1) % 24).padStart(2, "0")}:00`
        : `${d.getMonth() + 1}月${d.getDate()}日`,
      shortLabel: isDay ? String(d.getHours()).padStart(2, "0") : `${d.getMonth() + 1}/${d.getDate()}`,
      ...emptyTrendSlice(),
      costCents: 0,
      count: 0,
      speed: {
        normal: emptyTrendSlice(),
        fast: emptyTrendSlice(),
      },
    };
  });
  for (const event of events) {
    const ts = parseIsoOrMs(event.timestamp);
    if (!ts || ts < boundaries[0] || ts >= boundaries[boundaries.length - 1]) continue;
    const index = boundaries.findIndex((boundary, i) => i < boundaries.length - 1 && ts >= boundary && ts < boundaries[i + 1]);
    if (index < 0) continue;
    const t = decorateTokens(eventTokens(event));
    const bucket = buckets[index];
    addTrendSlice(bucket, t, event);
    addTrendSlice(bucket.speed[eventSpeedKey(event)], t, event);
    bucket.count += 1;
  }
  return buckets;
}

function eventCacheKey(event) {
  return cursorEventKey(event);
}

function cursorSnapshotProgress(event) {
  const tokens = eventTokens(event);
  return {
    tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: num(event.tokenUsage?.totalCents ?? event.chargedCents ?? event.costCents),
  };
}

function preferCursorSnapshot(current, candidate) {
  if (!current) return candidate;
  const a = cursorSnapshotProgress(current);
  const b = cursorSnapshotProgress(candidate);
  if (b.tokens !== a.tokens) return b.tokens > a.tokens ? candidate : current;
  return b.cost > a.cost ? candidate : current;
}

function collapseCursorSnapshots(events) {
  const merged = new Map();
  for (const event of events || []) {
    const key = eventCacheKey(event);
    merged.set(key, preferCursorSnapshot(merged.get(key), event));
  }
  return [...merged.values()];
}

async function fetchAllUsageEventPages(auth, userId, startDate, endDate) {
  const pageSize = 100;
  const requestPage = (page) => cursorFetch(auth, "POST", "https://cursor.com/api/dashboard/get-filtered-usage-events", {
    startDate: String(startDate), endDate: String(endDate), page, pageSize, userId,
  });
  const first = await requestPage(1);
  const total = num(first?.totalUsageEventsCount);
  const pageCount = Math.min(50, Math.ceil(total / pageSize));
  const events = [...(first?.usageEventsDisplay || [])];
  for (let firstPage = 2; firstPage <= pageCount; firstPage += 4) {
    const pages = [];
    for (let page = firstPage; page < Math.min(firstPage + 4, pageCount + 1); page += 1) pages.push(requestPage(page));
    const results = await Promise.all(pages);
    for (const result of results) events.push(...(result?.usageEventsDisplay || []));
  }
  return { events, total, truncated: pageCount * pageSize < total };
}

async function fetchCachedUsageEvents(auth, userId, fullStart, endDate) {
  const scope = `${userId}:${fullStart}`;
  const isPrimed = usageCachePrimed && usageCacheScope === scope;
  const latestTimestamp = isPrimed && usageEventCache.length
    ? Math.max(...usageEventCache.map((event) => parseIsoOrMs(event.timestamp) || 0))
    : 0;
  const queryStart = isPrimed ? Math.max(fullStart, (latestTimestamp || endDate) - 10 * 60_000) : fullStart;
  const result = await fetchAllUsageEventPages(auth, userId, queryStart, endDate);
  const merged = new Map();
  if (isPrimed) for (const event of usageEventCache) merged.set(eventCacheKey(event), event);
  for (const event of result.events) {
    const key = eventCacheKey(event);
    merged.set(key, preferCursorSnapshot(merged.get(key), event));
  }
  usageEventCache = [...merged.values()]
    .filter((event) => {
      const ts = parseIsoOrMs(event.timestamp);
      return ts && ts >= fullStart && ts <= endDate + 60_000;
    })
    .sort((a, b) => num(b.timestamp) - num(a.timestamp));
  usageCacheScope = scope;
  usageCachePrimed = true;
  return { events: usageEventCache, total: isPrimed ? usageEventCache.length : result.total, truncated: result.truncated };
}

function cursorEventToHistory(event, pricingSnapshot, autoBucketModels = [], history = null) {
  const descriptor = normalizeModelDescriptor(event.model);
  const tokens = eventTokens(event);
  const normalized = {
    source: "cursor",
    eventKey: eventCacheKey(event),
    timestamp: parseIsoOrMs(event.timestamp),
    model: event.model || "unknown",
    effort: descriptor.effort,
    fast: descriptor.fast,
    fastKnown: true,
    pool: isCursorModel(event.model, autoBucketModels) ? "cursor-models" : "other-models",
    ...tokens,
    reasoning: 0,
    costCents: eventCostCents(event),
    count: 1,
  };
  const existing = history?.getEvent("cursor", normalized.eventKey);
  const lockedPricing = history?.pricingSnapshot(existing?.pricingSnapshotId) || pricingSnapshot;
  const exactTotal = event.tokenUsage?.totalCents ?? event.chargedCents ?? null;
  return { ...normalized, ...priceEvent(normalized, lockedPricing, { authoritativeTotalCents: exactTotal }) };
}

function sumEventTokens(events) {
  let total = emptyTokens();
  for (const event of events) total = addTokens(total, eventTokens(event));
  return decorateTokens(total);
}

function eventCount(events) {
  return events.reduce((sum, event) => sum + Math.max(1, num(event.count) || 1), 0);
}

function lastEventFromHistory(events) {
  const event = events.at(-1);
  if (!event) return null;
  return {
    source: event.source,
    model: normalizeModelDescriptor(event.model).clean,
    effort: event.effort || null,
    fast: event.fast,
    fastKnown: event.fastKnown,
    at: parseIsoOrMs(event.timestamp),
    tokens: eventTokens(event),
    reasoning: num(event.reasoning),
    costCents: event.costCents,
    equivalentCostCents: event.equivalentCostCents,
    inputCostCents: event.inputCostCents,
    cacheReadCostCents: event.cacheReadCostCents,
    cacheWriteCostCents: event.cacheWriteCostCents,
    outputCostCents: event.outputCostCents,
  };
}

function trendBundle(events, now) {
  return {
    day: buildTrendSeries(events, "day", now),
    week: buildTrendSeries(events, "week", now),
    month: buildTrendSeries(events, "month", now),
  };
}

async function fetchCursorSnapshot(pricingSnapshot) {
  const auth = await resolveAuth();
  const [me, summary, period, plan] = await Promise.all([
    cursorFetch(auth, "GET", "https://cursor.com/api/auth/me"),
    cursorFetch(auth, "GET", "https://cursor.com/api/usage-summary"),
    cursorFetch(auth, "POST", "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {}, true),
    cursorFetch(auth, "POST", "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo", {}, true),
  ]);

  const planUsage = period?.planUsage || {};
  const individual = summary?.individualUsage?.plan || {};
  const onDemand = summary?.individualUsage?.onDemand || period?.spendLimitUsage || {};
  const cycleStart = parseIsoOrMs(summary?.billingCycleStart || period?.billingCycleStart);
  const cycleEnd = parseIsoOrMs(summary?.billingCycleEnd || period?.billingCycleEnd);
  const autoBucketModels = period?.autoBucketModels || [];
  const now = Date.now();
  const [agg, usageResult] = await Promise.all([
    cursorFetch(auth, "POST", "https://cursor.com/api/dashboard/get-aggregated-usage-events", {
      teamId: 0, startDate: String(cycleStart || now - 30 * DAY_MS), endDate: String(now), userId: me?.id,
    }),
    fetchCachedUsageEvents(auth, me?.id, Math.min(cycleStart || now, startOfLocalDay(now - 31 * DAY_MS)), now),
  ]);
  const history = getHistory();
  history.upsertEvents(usageResult.events.map((event) => cursorEventToHistory(event, pricingSnapshot, autoBucketModels, history)));

  const autoPct = pickUsagePercent(individual.autoPercentUsed, planUsage.autoPercentUsed);
  const apiPct = pickUsagePercent(individual.apiPercentUsed, planUsage.apiPercentUsed);
  const totalPct = pickUsagePercent(individual.totalPercentUsed, planUsage.totalPercentUsed);
  const includedLimit = num(individual.limit ?? planUsage.limit);
  const includedUsed = num(individual.used ?? planUsage.includedSpend);
  const includedRemaining = individual.remaining != null ? num(individual.remaining) : Math.max(0, includedLimit - includedUsed);
  const bonusUsed = num(individual.breakdown?.bonus ?? planUsage.bonusSpend);
  history.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp: now, usedPercent: autoPct, resetsAt: cycleEnd, startsAt: cycleStart });
  history.saveQuotaSample({ source: "cursor", pool: "other-models", timestamp: now, usedPercent: apiPct, resetsAt: cycleEnd, startsAt: cycleStart });

  let cursorTokens = emptyTokens();
  let otherTokens = emptyTokens();
  for (const row of agg?.aggregations || []) {
    const t = sumTokens(row);
    if (isCursorModel(row.modelIntent, autoBucketModels) || row.tier === 2) cursorTokens = addTokens(cursorTokens, t);
    else otherTokens = addTokens(otherTokens, t);
  }
  const cycleTokens = {
    input: num(agg?.totalInputTokens), output: num(agg?.totalOutputTokens),
    cacheRead: num(agg?.totalCacheReadTokens), cacheWrite: num(agg?.totalCacheWriteTokens),
  };

  const cycleEvents = history.getEvents({ sources: "cursor", start: cycleStart || now - 31 * DAY_MS, end: now + 60_000 });
  const trendEvents = history.getEvents({ sources: "cursor", start: startOfLocalDay(now - 29 * DAY_MS), end: now + 60_000 });
  const windows = { m5: emptyTokens(), h1: emptyTokens(), today: emptyTokens() };
  for (const event of trendEvents) {
    const ts = parseIsoOrMs(event.timestamp);
    const t = eventTokens(event);
    if (ts >= now - 5 * 60_000) windows.m5 = addTokens(windows.m5, t);
    if (ts >= now - 60 * 60_000) windows.h1 = addTokens(windows.h1, t);
    if (ts >= startOfLocalDay(now)) windows.today = addTokens(windows.today, t);
  }

  const lastEvent = lastEventFromHistory(trendEvents);
  const todayEvents = trendEvents.filter((event) => parseIsoOrMs(event.timestamp) >= startOfLocalDay(now));
  const todayCostCents = todayEvents.reduce((sum, event) => sum + eventCostCents(event), 0);
  const cycleCostCents = cycleEvents.reduce((sum, event) => sum + eventCostCents(event), 0);
  const cycleEquivalent = costSummary(cycleEvents);
  const cursorPoolEvents = cycleEvents.filter((event) => event.pool === "cursor-models" || (!event.pool && isCursorModel(event.model, autoBucketModels)));
  const otherPoolEvents = cycleEvents.filter((event) => event.pool === "other-models" || (!event.pool && !isCursorModel(event.model, autoBucketModels)));
  const cursorPoolEquivalent = costSummary(cursorPoolEvents);
  const otherPoolEquivalent = costSummary(otherPoolEvents);
  const cursorPoolQuota = inferPoolQuota(cursorPoolEquivalent, autoPct);
  const otherPoolQuota = inferPoolQuota(otherPoolEquivalent, apiPct, includedLimit);
  const todayEquivalent = costSummary(todayEvents);

  return {
    fetchedAt: now,
    email: me?.email || auth.email,
    planName: plan?.planInfo?.planName || summary?.membershipType || auth.membership || "Cursor",
    planPrice: plan?.planInfo?.price || null,
    unlimited: Boolean(summary?.isUnlimited),
    billingCycleStart: cycleStart,
    billingCycleEnd: cycleEnd,
    daysLeft: daysLeft(cycleEnd),
    displayMessage: period?.displayMessage || null,
    totalPercentUsed: totalPct,
    cursorModels: {
      name: "Cursor 模型", hint: "Grok / Composer", percentUsed: autoPct,
      percentRemaining: Math.max(0, 100 - autoPct),
      message: period?.autoModelSelectedDisplayMessage || summary?.autoModelSelectedDisplayMessage || null,
      tokens: decorateTokens(cursorTokens),
      apiEquivalent: cursorPoolEquivalent,
      quotaEstimate: cursorPoolQuota,
      speedUsage: speedUsageSummary(cursorPoolEvents),
    },
    otherModels: {
      name: "其他模型", hint: "Claude / GPT 等", percentUsed: apiPct,
      percentRemaining: Math.max(0, 100 - apiPct),
      message: period?.namedModelSelectedDisplayMessage || summary?.namedModelSelectedDisplayMessage || null,
      includedCents: { used: includedUsed, limit: includedLimit, remaining: includedRemaining },
      bonusCents: bonusUsed,
      tokens: decorateTokens(otherTokens),
      apiEquivalent: otherPoolEquivalent,
      quotaEstimate: otherPoolQuota,
      speedUsage: speedUsageSummary(otherPoolEvents),
    },
    onDemand: {
      enabled: Boolean(onDemand.enabled ?? (period?.spendLimitUsage && period.spendLimitUsage.individualLimit != null)),
      usedCents: num(onDemand.used ?? period?.spendLimitUsage?.individualUsed ?? period?.spendLimitUsage?.totalSpend),
      limitCents: onDemand.limit ?? period?.spendLimitUsage?.individualLimit ?? null,
      remainingCents: onDemand.remaining ?? period?.spendLimitUsage?.individualRemaining ?? null,
    },
    tokens: {
      cycle: decorateTokens(cycleTokens), m5: decorateTokens(windows.m5),
      h1: decorateTokens(windows.h1), today: decorateTokens(windows.today),
    },
    costs: {
      cycleCents: cycleCostCents,
      todayCents: todayCostCents,
      cycleEquivalent,
      todayEquivalent,
      cursorModelsEquivalent: cursorPoolEquivalent,
      otherModelsEquivalent: otherPoolEquivalent,
    },
    modelBreakdowns: buildModelBreakdowns(cycleEvents, autoBucketModels),
    trends: {
      ...trendBundle(trendEvents, now),
    },
    lastEvent,
    eventCount: eventCount(cycleEvents),
    eventsTruncated: usageResult.truncated,
  };
}

function codexPeriodStart(rateLimit, now) {
  const primary = rateLimit?.primary;
  if (primary?.resetsAt && primary?.windowMinutes) {
    const start = primary.resetsAt - primary.windowMinutes * 60_000;
    if (start < now && start > now - 90 * DAY_MS) return start;
  }
  return now - 30 * DAY_MS;
}

function codexRateWindows(rate) {
  const listed = Array.isArray(rate?.windows) && rate.windows.length
    ? rate.windows
    : [
        rate?.primary ? { slot: "primary", ...rate.primary } : null,
        rate?.secondary ? { slot: "secondary", ...rate.secondary } : null,
      ].filter(Boolean);
  const seen = new Set();
  return listed.filter((window) => {
    if (!window || !Number.isFinite(Number(window.windowMinutes))) return false;
    const key = `${window.slot || "window"}:${Number(window.windowMinutes)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentCodexRateWindow(window, now = Date.now()) {
  if (!window) return null;
  const resetsAt = Number(window.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt > now) return { ...window, expired: false };
  return {
    ...window,
    sampledUsedPercent: window.usedPercent,
    usedPercent: 0,
    percentRemaining: 100,
    expired: true,
    expiredAt: resetsAt,
    resetsAt: null,
  };
}

function quotaWindowLabel(windowMinutes) {
  if (!windowMinutes) return "额度窗口";
  if (windowMinutes === 300) return "5 小时额度";
  if (windowMinutes === 10_080) return "7 天额度";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440} 天额度`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60} 小时额度`;
  return `${windowMinutes} 分钟额度`;
}

function buildCodexSnapshot(now = Date.now(), pricingSnapshot = null) {
  const scan = scanCodexUsage();
  const history = getHistory();
  const codexDedupe = history.migrateCodexCumulativeEvents(scan.events);
  history.db.exec("BEGIN");
  try {
    for (const sample of scan.quotaSamples || []) history.saveQuotaSample(sample);
    history.db.exec("COMMIT");
  } catch (error) { history.db.exec("ROLLBACK"); throw error; }
  history.upsertEvents(scan.events.map((event) => {
    const existing = history.getEvent(event.source, event.eventKey);
    const originalPricing = history.pricingSnapshot(existing?.pricingSnapshotId) || pricingSnapshot;
    const priced = priceEvent(event, originalPricing);
    if (
      event.timestamp < (pricingSnapshot?.fetchedAt || now) - 5 * 60_000
      && priced.pricingStatus?.startsWith("official")
    ) priced.pricingStatus = `first-import-${priced.pricingStatus}`;
    return { ...event, ...priced };
  }));
  history.unifyCodexDollarEquivalent();
  const rate = scan.rateLimit;
  const sampledRateWindows = codexRateWindows(rate);
  const rateWindows = sampledRateWindows.map((window) => currentCodexRateWindow(window, now));
  const usageWindow = rateWindows
    .slice()
    .sort((a, b) => Number(a.windowMinutes) - Number(b.windowMinutes))[0] || null;
  for (const window of sampledRateWindows) {
    history.saveQuotaSample({
      source: "codex",
      pool: `${window.slot || "window"}-${window.windowMinutes}`,
      timestamp: rate.timestamp || now,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetsAt: window.resetsAt,
      planType: rate.planType || scan.planType,
    });
  }
  const periodStart = usageWindow?.expired
    ? usageWindow.expiredAt
    : codexPeriodStart({ primary: usageWindow }, now);
  const periodEvents = history.getEvents({ sources: "codex", start: periodStart, end: now + 60_000 });
  const quotaWindows = rateWindows.map((window) => {
    const start = window.expired ? window.expiredAt : codexPeriodStart({ primary: window }, now);
    const events = history.getEvents({ sources: "codex", start, end: Math.min(now + 1, (rate.timestamp || now) + 1) });
    const quotaEquivalent = quotaCostSummary(events);
    const ratio = Number(window.usedPercent) > 0 ? Number(window.usedPercent) / 100 : null;
    return {
      ...window,
      planType: rate.planType || scan.planType,
      name: quotaWindowLabel(window.windowMinutes),
      speedUsage: speedUsageSummary(events, { quota: true }),
      quotaEstimate: {
        usedCents: quotaEquivalent.equivalentCostCents,
        inferredTotalCents: ratio ? quotaEquivalent.equivalentCostCents / ratio : null,
        inferredTotalLowCents: ratio ? quotaEquivalent.equivalentCostLowCents / ratio : null,
        inferredTotalHighCents: ratio ? quotaEquivalent.equivalentCostHighCents / ratio : null,
        packageTotalSource: "usage-percent",
      },
    };
  });
  const primaryQuota = quotaWindows.find((window) => window.slot === "primary") || null;
  const secondaryQuota = quotaWindows.find((window) => window.slot === "secondary") || null;
  const activeQuota = quotaWindows.find((window) => window.slot === usageWindow?.slot && window.windowMinutes === usageWindow?.windowMinutes) || null;
  const trendEvents = history.getEvents({ sources: "codex", start: startOfLocalDay(now - 29 * DAY_MS), end: now + 60_000 });
  const todayStart = startOfLocalDay(now);
  const todayEvents = trendEvents.filter((event) => event.timestamp >= todayStart);
  const hourEvents = trendEvents.filter((event) => event.timestamp >= now - 60 * 60_000);
  const minuteEvents = trendEvents.filter((event) => event.timestamp >= now - 5 * 60_000);
  const periodEquivalent = costSummary(periodEvents);
  const periodQuotaEquivalent = quotaCostSummary(periodEvents);
  const usedPercent = usageWindow?.usedPercent;
  const ratio = Number(usedPercent) > 0 ? Number(usedPercent) / 100 : null;
  const totalEquivalent = ratio ? periodEquivalent.equivalentCostCents / ratio : null;
  const totalLow = ratio ? periodEquivalent.equivalentCostLowCents / ratio : null;
  const totalHigh = ratio ? periodEquivalent.equivalentCostHighCents / ratio : null;
  const quotaTotal = ratio ? periodQuotaEquivalent.equivalentCostCents / ratio : null;
  const quotaTotalLow = ratio ? periodQuotaEquivalent.equivalentCostLowCents / ratio : null;
  const quotaTotalHigh = ratio ? periodQuotaEquivalent.equivalentCostHighCents / ratio : null;
  const tierEvidence = periodEvents.reduce((counts, event) => {
    const key = event.tierSource === "response" ? "response" : event.tierSource ? "local" : "unknown";
    counts[key] += Math.max(1, num(event.count) || 1);
    return counts;
  }, { response: 0, local: 0, unknown: 0 });
  return {
    available: scan.available,
    fetchedAt: now,
    planName: codexPlanName(scan.planType),
    origins: scan.origins || [],
    files: scan.files || 0,
    periodStart,
    periodEnd: usageWindow?.resetsAt || null,
    periodLabel: quotaWindowLabel(usageWindow?.windowMinutes),
    quota: {
      active: activeQuota,
      primary: primaryQuota,
      secondary: secondaryQuota,
      windows: quotaWindows,
      shortLimit: rate?.shortLimit || (quotaWindows.some((window) => window.windowMinutes === 300) ? "present" : "unknown"),
      credits: rate?.credits || null,
      sampledAt: rate?.timestamp || null,
    },
    tokens: {
      period: sumEventTokens(periodEvents),
      today: sumEventTokens(todayEvents),
      h1: sumEventTokens(hourEvents),
      m5: sumEventTokens(minuteEvents),
    },
    modelBreakdowns: buildModelBreakdowns(periodEvents),
    trends: trendBundle(trendEvents, now),
    lastEvent: lastEventFromHistory(trendEvents),
    eventCount: eventCount(periodEvents),
    apiEquivalent: {
      ...periodEquivalent,
      inferredTotalCents: totalEquivalent,
      inferredTotalLowCents: totalLow,
      inferredTotalHighCents: totalHigh,
      inferredRemainingCents: totalEquivalent == null ? null : Math.max(0, totalEquivalent - periodEquivalent.equivalentCostCents),
    },
    quotaEquivalent: {
      ...periodQuotaEquivalent,
      inferredTotalCents: quotaTotal,
      inferredTotalLowCents: quotaTotalLow,
      inferredTotalHighCents: quotaTotalHigh,
      inferredRemainingCents: quotaTotal == null ? null : Math.max(0, quotaTotal - periodQuotaEquivalent.equivalentCostCents),
    },
    tierEvidence,
    costAvailable: periodEquivalent.pricedEvents > 0,
    dedupe: codexDedupe,
  };
}

function sourceView(label, periodLabel, events, now, costAvailable = null) {
  const costs = costSummary(events);
  return {
    label,
    periodLabel,
    eventCount: eventCount(events),
    costAvailable: costAvailable == null ? costs.pricedEvents > 0 : costAvailable,
    costCoveragePercent: costs.coveragePercent,
    costs,
    modelBreakdowns: buildModelBreakdowns(events),
    trends: trendBundle(events, now),
  };
}

function buildModelUsage(events, rangeKey = "month1", now = Date.now()) {
  const key = Object.hasOwn(MODEL_RANGE_SPECS, rangeKey) ? rangeKey : "month1";
  const spec = MODEL_RANGE_SPECS[key];
  const start = spec.durationMs == null ? 0 : Math.max(0, now - spec.durationMs);
  const rowsInRange = (Array.isArray(events) ? events : []).filter((event) => {
    const timestamp = parseIsoOrMs(event.timestamp);
    return timestamp >= start && timestamp < now + 60_000;
  });
  const sourceUsage = (label, rows) => {
    const costs = costSummary(rows);
    return {
      label,
      periodLabel: spec.label,
      eventCount: eventCount(rows),
      costAvailable: costs.pricedEvents > 0,
      costCoveragePercent: costs.coveragePercent,
      modelBreakdowns: buildModelBreakdowns(rows),
    };
  };
  const cursorEvents = rowsInRange.filter((event) => event.source === "cursor");
  const codexEvents = rowsInRange.filter((event) => event.source === "codex");
  return {
    key,
    label: spec.label,
    start,
    end: now,
    sources: {
      all: sourceUsage("全部", rowsInRange),
      cursor: sourceUsage("Cursor", cursorEvents),
      codex: sourceUsage("Codex", codexEvents),
    },
  };
}

function getModelUsage(rangeKey = "month1", now = Date.now()) {
  const key = Object.hasOwn(MODEL_RANGE_SPECS, rangeKey) ? rangeKey : "month1";
  const spec = MODEL_RANGE_SPECS[key];
  const start = spec.durationMs == null ? 0 : Math.max(0, now - spec.durationMs);
  const events = getHistory().getEvents({ start, end: now + 60_000 });
  return buildModelUsage(events, key, now);
}

async function fetchSnapshot({ forcePricing = false } = {}) {
  const now = Date.now();
  const history = getHistory();
  const pricingResult = await refreshPricing(history, { force: forcePricing, now });
  const pricingSnapshot = pricingResult.snapshot;
  const [cursorResult, codexResult] = await Promise.allSettled([
    fetchCursorSnapshot(pricingSnapshot),
    Promise.resolve().then(() => buildCodexSnapshot(now, pricingSnapshot)),
  ]);

  const cacheBreakdownEvents = history.getEventsNeedingCacheBreakdown();
  if (cacheBreakdownEvents.length) {
    const repriced = cacheBreakdownEvents.flatMap((event) => {
      const eventPricing = history.pricingSnapshot(event.pricingSnapshotId);
      if (!eventPricing) return [];
      return [{
        ...event,
        ...priceEvent(event, eventPricing, { authoritativeTotalCents: event.equivalentCostCents }),
      }];
    });
    if (repriced.length) history.upsertEvents(repriced);
  }

  const unpriced = history.getUnpricedEvents();
  if (unpriced.length) {
    history.upsertEvents(unpriced.map((event) => ({
      ...event,
      ...(() => {
        const eventPricing = history.pricingSnapshot(event.pricingSnapshotId) || pricingSnapshot;
        const priced = priceEvent(event, eventPricing, {
          authoritativeTotalCents: event.source === "cursor" ? event.costCents : null,
        });
        if (priced.pricingStatus !== "unavailable") priced.pricingStatus = `first-import-${priced.pricingStatus}`;
        return priced;
      })(),
    })));
    history.unifyCodexDollarEquivalent();
  }

  let cursor = null;
  let cursorCached = false;
  let cursorError = null;
  if (cursorResult.status === "fulfilled") {
    cursor = cursorResult.value;
    history.saveCache("cursor-snapshot", cursor);
  } else {
    cursorError = cursorResult.reason?.message || String(cursorResult.reason);
    const cached = history.loadCache("cursor-snapshot");
    if (cached) {
      cursor = cached.value;
      cursorCached = true;
    }
  }

  let codex = null;
  let codexError = null;
  if (codexResult.status === "fulfilled") codex = codexResult.value;
  else codexError = codexResult.reason?.message || String(codexResult.reason);

  if (!cursor && !codex) throw new Error(cursorError || codexError || "未找到可用的用量数据");

  if (codex) {
    const start = monthBounds(now).startAt - WEEK_MS;
    codex.monthlyQuota = buildCodexMonthly({
      windows: codex.quota?.windows,
      shortLimit: codex.quota?.shortLimit,
      samples: history.getQuotaSamples({ source: "codex", start, end: now + 1 }),
      events: history.getQuotaConsumption({ source: "codex", start, end: now + 1 }),
      now,
    });
  }

  const trendStart = startOfLocalDay(now - 29 * DAY_MS);
  const cursorTrendEvents = history.getEvents({ sources: "cursor", start: trendStart, end: now + 60_000 });
  const codexTrendEvents = history.getEvents({ sources: "codex", start: trendStart, end: now + 60_000 });
  const combinedEvents = [...cursorTrendEvents, ...codexTrendEvents].sort((a, b) => a.timestamp - b.timestamp);
  const combinedToday = combinedEvents.filter((event) => event.timestamp >= startOfLocalDay(now));
  const combinedHour = combinedEvents.filter((event) => event.timestamp >= now - 60 * 60_000);
  const combinedFiveMinutes = combinedEvents.filter((event) => event.timestamp >= now - 5 * 60_000);
  const codexTrendCosts = costSummary(codexTrendEvents);

  const cursorView = cursor ? {
    label: "Cursor",
    periodLabel: "当前账单周期",
    eventCount: cursor.eventCount,
    costAvailable: true,
    costCoveragePercent: cursor.costs?.cycleEquivalent?.coveragePercent ?? 100,
    modelBreakdowns: cursor.modelBreakdowns,
    trends: cursor.trends,
  } : sourceView("Cursor", "最近 30 天", cursorTrendEvents, now, true);
  const codexView = codex ? {
    label: "Codex",
    periodLabel: codex.periodLabel,
    eventCount: codex.eventCount,
    costAvailable: codexTrendCosts.pricedEvents > 0,
    costCoveragePercent: codexTrendCosts.coveragePercent,
    modelBreakdowns: codex.modelBreakdowns,
    trends: codex.trends,
  } : sourceView("Codex", "最近 30 天", codexTrendEvents, now);

  const base = cursor || {
    fetchedAt: now,
    email: null,
    planName: codex?.planName || "本机用量",
    billingCycleStart: null,
    billingCycleEnd: null,
    daysLeft: null,
    cursorModels: null,
    otherModels: null,
    onDemand: { enabled: false },
    tokens: { cycle: decorateTokens(emptyTokens()), today: decorateTokens(emptyTokens()), h1: decorateTokens(emptyTokens()), m5: decorateTokens(emptyTokens()) },
    costs: { cycleCents: 0, todayCents: 0, cycleEquivalent: costSummary([]), todayEquivalent: costSummary([]) },
    modelBreakdowns: { coarse: [], speed: [], exact: [] },
    trends: trendBundle([], now),
    lastEvent: null,
    eventCount: 0,
  };

  const result = {
    ...base,
    fetchedAt: now,
    codex,
    modelUsage: getModelUsage(loadSettings().modelRange, now),
    combined: {
      tokens: {
        today: sumEventTokens(combinedToday),
        h1: sumEventTokens(combinedHour),
        m5: sumEventTokens(combinedFiveMinutes),
        month: sumEventTokens(combinedEvents),
      },
      lastEvent: lastEventFromHistory(combinedEvents),
      eventCount: eventCount(combinedEvents),
      costs: costSummary(combinedEvents),
    },
    sources: {
      all: sourceView("全部", "最近 30 天", combinedEvents, now),
      cursor: cursorView,
      codex: codexView,
    },
    persistence: history.stats(),
    sourceStatus: {
      cursor: { ok: cursorResult.status === "fulfilled", cached: cursorCached, error: cursorError },
      codex: { ok: codexResult.status === "fulfilled", cached: false, error: codexError },
    },
    pricing: {
      id: pricingSnapshot?.id || null,
      fetchedAt: pricingSnapshot?.fetchedAt || null,
      status: pricingSnapshot?.status || "built-in",
      note: pricingSnapshot?.note || null,
      sourceUrls: pricingSnapshot?.sourceUrls || [],
      nextCheckAt: pricingResult.nextCheckAt || null,
      updated: pricingResult.updated,
    },
  };
  result.quotaInsights = buildQuotaInsights(result, now);
  result.quotaTimeline = getQuotaTimeline({
    pool: loadSettings().quotaLevelPool,
    now,
    live: livePointsFromSnapshot(result, now),
  });
  return result;
}

function getQuotaTimeline({ pool, cycleKey, now = Date.now(), live = [] } = {}) {
  return buildQuotaTimeline(getHistory().getQuotaSamples(), { pool, cycleKey, now, live });
}

function queryUsageEvents({ source = "all", query = "", offset = 0, limit = 40 } = {}) {
  const sources = source && source !== "all" ? source : undefined;
  return getHistory().queryEvents({ sources, query, offset, limit });
}

function getPricingCatalog({ snapshotId = null, source = "all" } = {}) {
  const history = getHistory();
  const snapshots = history.listPricingSnapshots(36);
  const selected = snapshotId == null
    ? mergeFallbackCatalog(history.latestPricingSnapshot())
    : history.pricingSnapshot(snapshotId);
  const current = selected || mergeFallbackCatalog(history.latestPricingSnapshot());
  return {
    snapshots,
    selectedId: current?.id ?? null,
    snapshot: current ? summarizePricingSnapshot(current) : null,
    rows: current ? flattenPricingSnapshot(current, { source }) : [],
  };
}

module.exports = {
  APP_DIR,
  loadSettings,
  saveSettings,
  fetchSnapshot,
  normalizeModelDescriptor,
  buildModelBreakdowns,
  buildTrendSeries,
  costSummary,
  quotaCostSummary,
  speedUsageSummary,
  buildModelUsage,
  getModelUsage,
  getQuotaTimeline,
  queryUsageEvents,
  getPricingCatalog,
  collapseCursorSnapshots,
  currentCodexRateWindow,
  inferPoolQuota,
  isCursorModel,
  pickUsagePercent,
};
