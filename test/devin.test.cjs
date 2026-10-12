const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { UsageHistory } = require("../src/history.cjs");
const { normalizeStatus, fetchSubscription, scanDevinUsage, readCredential } = require("../src/devin.cjs");
const { builtInSnapshot, priceEvent, parseDevinListPricing } = require("../src/pricing.cjs");
const { buildModelUsage, getTrendUsage } = require("../src/lib.cjs");
const { getReceipt } = require("../src/receipt.cjs");
const { exportUsageEvents } = require("../src/event-export.cjs");
const { buildQuotaTimeline, livePointsFromSnapshot } = require("../src/quota-timeline.cjs");
const { buildQuotaInsights } = require("../src/quota-insights.cjs");
const { meterRows } = require("../src/taskbar-meters.cjs");
const { combinedTank } = require("../src/renderer/liquid-pool.js");
const { flattenPricingSnapshot } = require("../src/pricing-table.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "widget-devin-test-"));
  const history = new UsageHistory(path.join(dir, "history.sqlite"));
  t.after(() => { history.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "credentials.toml");
  fs.writeFileSync(file, 'windsurf_api_key = "synthetic-key"\napi_server_url = "https://server.codeium.com"\n');
  return { dir, history, file };
}
function payload(now, remaining = 80) {
  return { userStatus: { email: "private@example.invalid", planStatus: {
    planInfo: { planName: "Pro" }, availablePromptCredits: "-1",
    dailyQuotaRemainingPercent: remaining, dailyQuotaResetAtUnix: Math.floor((now + 3600000) / 1000),
    weeklyQuotaRemainingPercent: 75, weeklyQuotaResetAtUnix: Math.floor((now + 86400000) / 1000),
  } } };
}

test("Devin subscription keeps fractional/zero quotas, unlimited sentinel, and strips identity", () => {
  const now = Date.now();
  const data = normalizeStatus(payload(now, 0), now);
  assert.equal(data.planName, "Pro");
  assert.equal(data.quota.windows[0].usedPercent, 100);
  assert.equal(data.credits.availablePromptCredits, -1);
  assert.equal(data.quota.windows[0].resetsAt, Math.floor((now + 3600000) / 1000) * 1000);
  assert.equal(data.quota.windows[0].startEstimated, true);
  assert.doesNotMatch(JSON.stringify(data), /private@example/);
  assert.equal(normalizeStatus(payload(now, 87.125), now).quota.windows[0].percentRemaining, 87.125);
  assert.throws(() => normalizeStatus(payload(now, 101)), /百分比/);
  assert.throws(() => normalizeStatus({ userStatus: { planStatus: {} } }), /用量字段/);
  const missing = payload(now); delete missing.userStatus.planStatus.dailyQuotaRemainingPercent;
  assert.equal(normalizeStatus(missing, now).quota.windows.length, 1);
});

test("Devin read-only query caches per account, never writes cached points, expires old windows and sanitizes failures", async t => {
  const { history, file } = fixture(t);
  const now = Date.now(); let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).metadata.apiKey, "synthetic-key");
    return { ok: true, json: async () => payload(now) };
  };
  const fresh = await fetchSubscription(history, { now, file, fetchImpl });
  assert.equal(fresh.ok, true);
  assert.equal(history.getQuotaSamples({ source: "devin" }).length, 2);
  const cached = await fetchSubscription(history, { now: fresh.sampledAt + 1000, file, fetchImpl });
  assert.equal(cached.cached, true); assert.equal(calls, 1);
  assert.equal(cached.sampledAt, fresh.sampledAt);
  assert.equal(history.getQuotaSamples({ source: "devin" }).length, 2);
  const failed = await fetchSubscription(history, { now: now + 2 * 86400000, file, force: true,
    fetchImpl: async () => { throw new Error("synthetic-key private transport details"); } });
  assert.equal(failed.ok, false); assert.equal(failed.cached, true);
  assert.equal(failed.sampledAt, fresh.sampledAt);
  assert.ok(failed.quota.windows.every(w => w.expired));
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-key|private transport/);
  assert.equal(history.getQuotaSamples({ source: "devin" }).length, 2);
  let retryCalls = 0;
  const throttled = await fetchSubscription(history, { now: now + 2 * 86400000 + 1000, file,
    fetchImpl: async () => { retryCalls++; throw new Error("unexpected retry"); } });
  assert.equal(retryCalls, 0);
  assert.equal(throttled.error, failed.error);
  assert.equal(throttled.sampledAt, fresh.sampledAt);
  fs.writeFileSync(file, 'windsurf_api_key = "different-key"\napi_server_url = "https://server.codeium.com"\n');
  const different = await fetchSubscription(history, { now, file, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(different.cached, false); assert.equal(different.quota, undefined);
  assert.notEqual(different.accountKey, fresh.accountKey);
  assert.doesNotMatch(JSON.stringify(history.db.prepare("SELECT value FROM app_cache").all()), /synthetic-key|different-key|private@example/);
});

test("Devin rejects credential redirection to arbitrary hosts and handles missing login", async t => {
  const { file, history } = fixture(t);
  fs.writeFileSync(file, "windsurf_api_key = 'synthetic-key'\napi_server_url = 'https://untrusted.example.invalid'\n");
  assert.throws(() => readCredential(file), /官方 HTTPS/);
  let calls = 0;
  const result = await fetchSubscription(history, { file, fetchImpl: async () => { calls++; } });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  const missing = await fetchSubscription(history, { file: path.join(path.dirname(file), "missing.toml") });
  assert.equal(missing.cached, false); assert.equal(missing.quota, undefined);
});

test("Devin scanner deduplicates split/fork nodes by request, retains retries and actual request models", t => {
  const { dir } = fixture(t); const file = path.join(dir, "sessions.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,chat_message TEXT,created_at INTEGER)");
  const insert = db.prepare("INSERT INTO message_nodes(chat_message,created_at) VALUES (?, ?)");
  const put = (id, model, extra = {}) => insert.run(JSON.stringify({ message_id: "same-message", role: "assistant",
    content: "private conversation must never be imported", metadata: { request_id: id, generation_model: model,
      created_at: "2026-10-10T12:00:00Z", metrics: { input_tokens: 100, output_tokens: 40,
        cache_read_tokens: 300, cache_creation_tokens: 20, ...extra } } }), 1791633600);
  put("request-a", "swe-2-high"); put("request-a", "swe-2-high");
  put("request-b", "claude-opus-5-5-medium");
  put("request-empty", "swe-2-high", { input_tokens: null, output_tokens: 0, cache_read_tokens: null, cache_creation_tokens: null });
  put("request-bad", "swe-2-high", { input_tokens: -2 });
  db.close();
  const scan = scanDevinUsage(file);
  assert.equal(scan.events.length, 2);
  assert.equal(scan.scanErrors.length, 1);
  assert.deepEqual(scan.events.map(e => e.model), ["swe-2-high", "claude-opus-5-5-medium"]);
  assert.equal(scan.events[0].effort, "high"); assert.equal(scan.events[0].fastKnown, false);
  assert.equal(scan.events[0].input, 100); assert.equal(scan.events[0].cacheWrite, 20);
  assert.doesNotMatch(JSON.stringify(scan), /private conversation|request-a/);
  assert.deepEqual(scanDevinUsage(file).events, scan.events);
});

test("SWE list-priced usage reaches models, trends, receipts and filtered exports without consuming quota", t => {
  const { history, dir } = fixture(t);
  const now = new Date(2026, 9, 10, 12).getTime();
  const pricing = builtInSnapshot(now);
  const event = { source: "devin", eventKey: "devin:synthetic", timestamp: now - 60000,
    model: "swe-2-high", effort: "high", fast: false, fastKnown: false, count: 1,
    input: 1000000, output: 500000, cacheRead: 2000000, cacheWrite: 0 };
  const priced = { ...event, ...priceEvent(event, pricing) };
  assert.ok(Math.abs(priced.equivalentCostCents - 1110) < 1e-8);
  assert.equal(priced.quotaEquivalentCostCents, null);
  assert.equal(priceEvent({ ...event, model: "swe-unknown" }, pricing).equivalentCostCents, null);
  const claude = priceEvent({ ...event, model: "claude-opus-5-5-medium" }, pricing);
  assert.ok(claude.equivalentCostCents > 0);
  history.upsertEvents([priced]); history.upsertEvents([priced]);
  assert.equal(history.getEvents({ sources: "devin", end: now + 1 }).length, 1);
  const models = buildModelUsage(history.getEvents({ end: now + 1 }), "all", now);
  assert.equal(models.sources.devin.eventCount, 1);
  assert.deepEqual(models.sources.all.modelBreakdowns, models.sources.devin.modelBreakdowns);
  const trend = getTrendUsage({ count: 1, unit: "day" }, now, history);
  const total = trend.sources.devin.trends.custom.reduce((n, p) => n + (p.equivalentCostCents || 0), 0);
  assert.ok(Math.abs(total - 1110) < 1e-8);
  const receipt = getReceipt(history, { date: "2026-10-10", source: "devin", period: "day" });
  assert.equal(receipt.rows.length, 1);
  assert.equal(receipt.rows[0].source, "devin"); assert.match(receipt.costNote, /非 Devin 订阅扣费/);
  for (const kind of ["csv", "json"]) {
    const output = path.join(dir, `export.${kind}`);
    assert.equal(exportUsageEvents(history, { filePath: output, kind, source: "devin" }).count, 1);
    assert.match(fs.readFileSync(output, "utf8"), /devin/);
  }
  const subscription = normalizeStatus(payload(now, 100), now);
  const data = { devin: { quota: subscription.quota, subscription: { cached: false } } };
  assert.equal(meterRows({ data }, now).rows.at(-1).meters[0].value, 100);
  assert.equal(meterRows({ data }, now).rows.at(-1).meters[0].remainingCents, null);
  const insight = buildQuotaInsights(data, now).find(i => i.id === "devin-1440");
  assert.equal(insight.usedPercent, 0);
  const live = livePointsFromSnapshot(data, now);
  const timeline = buildQuotaTimeline([], { pool: "devin-1440", now, live });
  assert.equal(timeline.pool, "devin-1440"); assert.equal(timeline.series[0].remainingPercent, 100);
  assert.equal(timeline.cycle.reference.estimated, true);
  // Restored billing changes the authoritative water level regardless of list cost.
  data.devin.quota = normalizeStatus(payload(now, 90), now).quota;
  assert.equal(meterRows({ data }, now).rows.at(-1).meters[0].value, 90);
  assert.ok(flattenPricingSnapshot(pricing, { source: "devin" }).some(r => r.model === "swe-2" && r.input === 3));
  const combined = combinedTank([{ id: "devin-window-1440", source: "devin", remaining: 100, capacityCents: null },
    { id: "cursor-models", remaining: 50, capacityCents: 1000 }]);
  assert.equal(combined.capacityCents, 1000); assert.equal(combined.remainingCents, 500);
});

test("Devin price refresh reads explicit list pricing instead of free promotion", () => {
  const models = parseDevinListPricing("SWE-2 is free through October 15. List pricing ($3.00/1M input, $15.00/1M output, $0.30/1M cache input) applies afterward.");
  assert.equal(models["swe-2"].standard.short.input, 3);
  assert.equal(models["swe-2"].standard.short.cacheRead, 0.3);
  assert.throws(() => parseDevinListPricing("SWE-2 is free"), /原价格式/);
});
