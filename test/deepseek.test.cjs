const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { zstdCompressSync } = require("node:zlib");
const { UsageHistory } = require("../src/history.cjs");
const { parseSession, DeepSeekScanner, resolveCredential, normalizeBalances, fetchBalance, completeZstdPrefix } = require("../src/deepseek.cjs");
const { buildBalanceTimeline } = require("../src/balance-timeline.cjs");
const { buildModelUsage, getTrendUsage } = require("../src/lib.cjs");
const { priceEvent } = require("../src/pricing.cjs");
const { modelSlices } = require("../src/renderer/usage-charts.js");
const { getReceipt } = require("../src/receipt.cjs");
const { csvRow } = require("../src/event-export.cjs");

const now = +new Date(2026, 9, 5, 12);
const header = { type: "session", version: 4, id: "test-session", isSeeded: false };
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 };
const row = (seq, type = "assistant/message", data = {}) => ({ seq, time: now + seq, type,
  data: { turn: 1, step: 0, message: { source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" } }, usage, ...data } });
const log = (...rows) => [header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "widget-deepseek-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function history(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "widget-deepseek-db-"));
  const h = new UsageHistory(path.join(root, "history.sqlite"));
  t.after(() => { h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test("Harness settlement replaces duplicate samples, retry is additive and stream usage uses the last sample", () => {
  const rows = parseSession(log(
    { type: "request/header", seq: 0, time: now, data: { header: { config: { model: "deepseek-v4-pro", reasoningEffort: "high" } } } },
    row(1), row(2, "assistant/message", { usage: { ...usage, outputTokens: 25 } }),
    row(3, "llm/retry-started"),
    row(4, "assistant/attempt", { usage: undefined, stream: [
      { type: "chunk", chunk: { type: "usage", usage: { ...usage, outputTokens: 2 } } },
      { type: "chunk", chunk: { type: "usage", usage: { ...usage, outputTokens: 10 } } },
    ] }), row(5, "assistant/message", { usage: { ...usage, outputTokens: 10 } }),
    row(6, "assistant/message", { step: 1 }),
  ));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].output, 25);
  assert.equal(rows[1].output, 10);
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].cacheRead, 900);
  assert.equal(rows[0].effort, "high");
  assert.equal(rows[0].fastKnown, false);
  assert.equal(rows.reduce((sum, r) => sum + r.input + r.output + r.cacheRead + r.cacheWrite, 0), 3205);
});

test("fork-inherited usage and context-pressure estimates are excluded", () => {
  const text = [{ ...header, isSeeded: true }, row(0),
    { type: "session/end-seed", seq: 1, data: { inherited: true } },
    { type: "request/context", seq: 2, data: { totalTokens: 999999 } }, row(3, "assistant/message", { turn: 2 }),
  ].map(JSON.stringify).join("\n") + "\n";
  const events = parseSession(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, now + 3);
  assert.throws(() => parseSession(JSON.stringify({ ...header, version: 5 }) + "\n"), /版本/);
});

test("scanner reads only latest generation, caches unchanged files, handles partial appends and restart without duplication", (t) => {
  const root = directory(t);
  const file = path.join(root, "session.v4.jsonl");
  fs.writeFileSync(path.join(root, "session.v2.jsonl"), log(row(9)));
  fs.writeFileSync(file, log(row(1)) + '{"type":');
  const scan = new DeepSeekScanner([root]);
  const h = history(t);
  const first = scan.scan();
  assert.equal(first.files, 1);
  assert.equal(first.events.length, 1);
  h.upsertEvents(first.events);
  assert.equal(scan.scan().events.length, 0);
  fs.writeFileSync(file, log(row(1), row(2, "assistant/message", { step: 1 })));
  h.upsertEvents(scan.scan().events);
  h.upsertEvents(new DeepSeekScanner([root]).scan().events);
  assert.equal(h.stats().sources.deepseek.count, 2);
  fs.writeFileSync(file, log(row(1)) + "broken\n");
  assert.equal(scan.scan().scanErrors.length, 1);
  assert.equal(h.stats().sources.deepseek.count, 2);
});

test("compressed concatenated frames preserve completed usage while final frame is being written", (t) => {
  const first = zstdCompressSync(log(row(1)));
  const next = zstdCompressSync(JSON.stringify(row(2, "assistant/message", { step: 1 })) + "\n");
  const torn = Buffer.concat([first, next.subarray(0, next.length - 2)]);
  assert.deepEqual(completeZstdPrefix(torn), first);
  const root = directory(t);
  const file = path.join(root, "session.v4.jsonl.zstd");
  fs.writeFileSync(file, torn);
  const scanner = new DeepSeekScanner([root]);
  assert.equal(scanner.scan().events.length, 1);
  fs.writeFileSync(file, Buffer.concat([first, next]));
  const complete = scanner.scan();
  assert.deepEqual(complete.scanErrors, []);
  assert.equal(complete.events.length, 2);
  // Electron versions without native Zstandard use the same fallback path.
  const { decodeZstd } = require("../src/deepseek.cjs");
  assert.equal(parseSession(decodeZstd(Buffer.concat([first, next]), require("fzstd").decompress)).length, 2);
});

test("credentials follow environment, account, managed refs and dotenv without disclosing secrets", (t) => {
  const home = directory(t), cwd = directory(t);
  const credentials = path.join(home, ".credentials.yaml");
  fs.writeFileSync(credentials, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "sk-managed"\n');
  assert.equal(resolveCredential({ home, cwd, env: {} }).secret, "sk-managed");
  fs.appendFileSync(credentials, 'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload: {version: 1, issuer: "https://platform.deepseek.com", token: "account-secret"}\n');
  assert.equal(resolveCredential({ home, cwd, env: {} }).kind, "account");
  assert.equal(resolveCredential({ home, cwd, env: { DEEPSEEK_API_KEY: "sk-env" } }).secret, "sk-env");
  fs.writeFileSync(credentials, "not: [valid");
  assert.equal(resolveCredential({ home, cwd, env: { DEEPSEEK_API_KEY: "sk-env" } }).secret, "sk-env");
  fs.unlinkSync(credentials);
  fs.writeFileSync(path.join(cwd, ".env"), 'export DEEPSEEK_API_KEY="sk-project"\n');
  assert.equal(resolveCredential({ home, cwd, env: {} }).secret, "sk-project");
  fs.writeFileSync(credentials, 'version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload: {version: 1, issuer: "https://untrusted.example", token: "secret"}\n');
  assert.throws(() => resolveCredential({ home, cwd, env: {} }), /非官方/);
});

test("API balance refresh persists samples, retains timestamp on failure, and isolates changed credentials", async (t) => {
  const h = history(t);
  const credential = { kind: "api-key", secret: "sk-test-secret" };
  const body = { balance_infos: [
    { currency: "CNY", total_balance: "42.1234", topped_up_balance: "36.1234", granted_balance: "6" },
    { currency: "USD", total_balance: "2.5", topped_up_balance: "2.5", granted_balance: "0" },
  ] };
  let request;
  const result = await fetchBalance(h, { now, credential, fetchFn: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => body };
  } });
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.options.headers.Authorization, "Bearer sk-test-secret");
  assert.equal(request.options.redirect, "error");
  assert.equal(result.ok, true);
  assert.equal(h.getBalanceSamples({ accountKey: result.accountKey, currency: "CNY", end: now + 1 })[0].balance, 42.1234);
  assert.equal(h.getBalanceSamples({ accountKey: result.accountKey, currency: "USD", end: now + 1 })[0].balance, 2.5);
  assert.ok(!JSON.stringify(result).includes(credential.secret));
  const fail = async () => { throw new Error("transport error sk-test-secret"); };
  const cached = await fetchBalance(h, { now: now + 1000, credential, fetchFn: fail });
  assert.equal(cached.cached, true);
  assert.equal(cached.sampledAt, now);
  assert.ok(!cached.error.includes(credential.secret));
  assert.equal(h.getBalanceSamples({ accountKey: result.accountKey, currency: "CNY", end: now + 2000 }).length, 1);
  const changed = await fetchBalance(h, { credential: { ...credential, secret: "other-account" }, fetchFn: fail });
  assert.equal(changed.cached, false);
  assert.deepEqual(changed.balances, []);
  assert.equal(h.loadCache("deepseek-active-account").value.accountKey, changed.accountKey);
  await fetchBalance(h, { credential: null });
  assert.equal(h.loadCache("deepseek-active-account").value.accountKey, null);
});

test("account login uses official grant header and separates recharge and bonus currencies", async (t) => {
  const h = history(t);
  const body = { code: 0, data: { biz_code: 0, biz_data: {
    normal_wallets: [{ currency: "CNY", balance: "3.5" }, { currency: "USD", balance: "1" }],
    bonus_wallets: [{ currency: "CNY", balance: "6" }],
  } } };
  const result = await fetchBalance(h, { now, credential: { kind: "account", secret: "opaque-grant" }, fetchFn: async (url, options) => {
    assert.equal(url, "https://platform.deepseek.com/api/v0/users/get_user_summary");
    assert.equal(options.headers["x-dsh-auth-token"], "opaque-grant");
    return { ok: true, json: async () => body };
  } });
  assert.equal(result.balances[0].total, 9.5);
  assert.equal(result.balances[1].total, 1);
  assert.throws(() => normalizeBalances({ balance_infos: [{ currency: "CNY", total_balance: null }] }, "api-key"));
  const malformed = await fetchBalance(h, { credential: { kind: "api-key", secret: "new" }, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.balances, []);
});

test("calendar balance windows use Monday weeks, leap months and actual currency without invented historical points", () => {
  const current = +new Date(2024, 1, 29, 12);
  const samples = [
    { at: +new Date(2024, 1, 26, 10), currency: "CNY", balance: 100 },
    { at: +new Date(2024, 1, 29, 11), currency: "CNY", balance: 90 },
    { at: current, currency: "CNY", balance: 140 },
    { at: current, currency: "USD", balance: 1 },
  ];
  const day = buildBalanceTimeline(samples, { now: current });
  assert.equal(day.series.length, 2);
  assert.equal(day.change, 50);
  const week = buildBalanceTimeline(samples, { range: "week", now: current });
  assert.equal(new Date(week.cycle.startAt).getDay(), 1);
  assert.equal(week.series.length, 3);
  const month = buildBalanceTimeline(samples, { range: "month", now: current });
  assert.equal(new Date(month.cycle.endAt).getMonth(), 2);
  assert.equal(month.cycle.reference, undefined);
  const year = buildBalanceTimeline(samples, { range: "year", now: current });
  assert.equal(new Date(year.cycle.startAt).getMonth(), 0);
  assert.equal(year.series[0].at, samples[0].at);
  const empty = buildBalanceTimeline([], { now: current });
  assert.deepEqual(empty.series, []);
  assert.equal(empty.cycle.endRemaining, null);
});

test("large balance histories retain endpoint and top-up extrema while bounding chart density", () => {
  const samples = Array.from({ length: 10000 }, (_, i) => ({ at: now - 20000 + i, currency: "CNY", balance: i === 5321 ? 300 : 100 - i / 1000 }));
  const view = buildBalanceTimeline(samples, { now });
  assert.equal(view.sampleCount, 10000);
  assert.ok(view.series.length <= 1200);
  assert.equal(view.series[0].at, samples[0].at);
  assert.equal(view.series.at(-1).at, samples.at(-1).at);
  assert.ok(view.series.some((sample) => sample.balance === 300));
});

test("DeepSeek integrates model, donut, custom trends, receipts and export while keeping unrecorded USD costs unavailable", (t) => {
  const h = history(t);
  const event = parseSession(log(row(1)))[0];
  h.upsertEvents([event]);
  const model = buildModelUsage([event], "all", now + 1000);
  assert.equal(model.sources.deepseek.eventCount, 1);
  assert.equal(model.sources.deepseek.costAvailable, false);
  assert.equal(modelSlices(model.sources, { source: "all" }).total, 1070);
  const trend = getTrendUsage({ count: 1, unit: "day" }, now + 1000, h);
  assert.equal(trend.sources.deepseek.trends.custom.reduce((sum, bucket) => sum + bucket.total, 0), 1070);
  const receipt = getReceipt(h, { date: "2026-10-05", source: "deepseek" });
  assert.equal(receipt.rows[0].count, 1);
  assert.equal(receipt.rows[0].unpriced, 1);
  assert.match(csvRow(event), /deepseek/);
  assert.equal(priceEvent({ ...event, model: "gpt-6.1-sol" }, null).equivalentCostCents, null);
});
