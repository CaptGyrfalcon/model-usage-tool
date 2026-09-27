// Reconcile locally stored Cursor Auto events with their server-reported model totals.
// Dry run by default. --apply creates a consistent SQLite backup before updating rows.
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
const { resolveAuth, cursorFetch } = require("../src/lib.cjs");
const { cursorEventKey } = require("../src/identity.cjs");

const dbPath = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
  "cursor-usage-widget", "usage-history.sqlite");
const apply = process.argv.includes("--apply");

function tokenCount(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function fetchDefaultEvents(startAt) {
  const auth = await resolveAuth();
  const me = await cursorFetch(auth, "GET", "https://cursor.com/api/auth/me");
  const endAt = Date.now();
  const pageSize = 100;
  const first = await cursorFetch(auth, "POST", "https://cursor.com/api/dashboard/get-filtered-usage-events", {
    startDate: String(startAt), endDate: String(endAt), page: 1, pageSize, userId: me.id,
  });
  const total = Number(first?.totalUsageEventsCount) || 0;
  const pages = Math.ceil(total / pageSize);
  if (pages > 50) throw new Error(`用量事件共 ${pages} 页，超过安全分页上限`);
  const events = [...(first?.usageEventsDisplay || [])];
  for (let page = 2; page <= pages; page += 1) {
    const result = await cursorFetch(auth, "POST", "https://cursor.com/api/dashboard/get-filtered-usage-events", {
      startDate: String(startAt), endDate: String(endAt), page, pageSize, userId: me.id,
    });
    events.push(...(result?.usageEventsDisplay || []));
  }
  if (events.length < total) throw new Error(`用量事件分页不完整：${events.length}/${total}`);
  return events.filter((event) => event.model === "default");
}

async function main() {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = reader.prepare(`SELECT event_key, timestamp, model, pool, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, equivalent_cost_cents
      FROM usage_events WHERE source = 'cursor' AND model = 'default'`).all();
  } finally { reader.close(); }
  if (!rows.length) {
    console.log(JSON.stringify({ matched: 0, reason: "本地没有 default 事件" }));
    return;
  }

  const startAt = Math.min(...rows.map((row) => Number(row.timestamp))) - 60_000;
  const fetched = await fetchDefaultEvents(startAt);
  const byKey = new Map();
  for (const event of fetched) {
    const key = cursorEventKey(event);
    const previous = byKey.get(key);
    const tokens = event.tokenUsage || {};
    const progress = tokenCount(tokens.inputTokens) + tokenCount(tokens.outputTokens)
      + tokenCount(tokens.cacheReadTokens) + tokenCount(tokens.cacheWriteTokens);
    if (!previous || progress > previous.progress) byKey.set(key, { event, progress });
  }

  const matches = [];
  const unmatched = [];
  for (const row of rows) {
    const raw = byKey.get(row.event_key)?.event;
    const total = cents(raw?.tokenUsage?.totalCents);
    if (!raw || total == null) { unmatched.push(row.event_key); continue; }
    if (Math.abs(Number(row.timestamp) - Number(raw.timestamp)) > 1) {
      throw new Error("匹配事件的时间戳不一致，停止写入");
    }
    const tokens = raw.tokenUsage || {};
    const values = [tokenCount(tokens.inputTokens), tokenCount(tokens.outputTokens),
      tokenCount(tokens.cacheReadTokens), tokenCount(tokens.cacheWriteTokens)];
    const stored = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens];
    if (values.some((value, index) => value !== stored[index])) {
      throw new Error("匹配事件的 Token 数不一致，停止写入");
    }
    matches.push({ key: row.event_key, total, charged: cents(raw.chargedCents),
      previous: row.equivalent_cost_cents });
  }
  const summary = {
    localDefaults: rows.length,
    serverDefaults: byKey.size,
    matched: matches.length,
    unmatched: unmatched.length,
    previousEquivalentCents: matches.reduce((sum, row) => sum + (Number(row.previous) || 0), 0),
    serverEquivalentCents: matches.reduce((sum, row) => sum + row.total, 0),
  };
  if (!apply || !matches.length) {
    console.log(JSON.stringify({ mode: "dry-run", ...summary }, null, 2));
    return;
  }

  const source = new DatabaseSync(dbPath, { readOnly: true });
  const backupPath = path.join(path.dirname(dbPath),
    `usage-history.before-cursor-default-${Date.now()}.sqlite`);
  try { await backup(source, backupPath); } finally { source.close(); }
  const check = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (check.prepare("PRAGMA quick_check").get().quick_check !== "ok") {
      throw new Error("备份数据库校验失败，停止写入");
    }
  } finally { check.close(); }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const update = db.prepare(`UPDATE usage_events SET
      pool = 'cursor-models', fast = NULL, cost_cents = COALESCE(?, cost_cents),
      equivalent_cost_cents = ?, equivalent_cost_low_cents = ?, equivalent_cost_high_cents = ?,
      quota_equivalent_cost_cents = ?, quota_equivalent_cost_low_cents = ?, quota_equivalent_cost_high_cents = ?,
      input_cost_cents = NULL, cache_read_cost_cents = NULL, cache_write_cost_cents = NULL,
      cache_cost_cents = NULL, output_cost_cents = NULL, pricing_status = 'api-total-unallocated'
      WHERE source = 'cursor' AND model = 'default' AND event_key = ?`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of matches) {
        const changed = update.run(row.charged, row.total, row.total, row.total,
          row.total, row.total, row.total, row.key).changes;
        if (changed !== 1) throw new Error("事件在写入期间发生变化，已回滚");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const verified = db.prepare(`SELECT COUNT(*) n, SUM(equivalent_cost_cents) cents FROM usage_events
      WHERE source = 'cursor' AND model = 'default' AND pricing_status = 'api-total-unallocated'`).get();
    if (Number(verified.n) < matches.length) throw new Error("写入后记录数校验失败");
    console.log(JSON.stringify({ mode: "applied", ...summary, backupPath,
      verifiedPricedDefaults: Number(verified.n), verifiedEquivalentCents: Number(verified.cents) }, null, 2));
  } finally { db.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
