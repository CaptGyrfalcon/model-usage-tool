// Explicit, staged recovery. Downloads stay under ignored out/ until import is requested.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { APP_DIR, HISTORY_DB_PATH, UsageHistory } = require("../src/history.cjs");
const { resolveAuth, cursorFetch, cursorEventToHistory, collapseCursorSnapshots } = require("../src/lib.cjs");
const { cursorEventKey } = require("../src/identity.cjs");

const directory = path.resolve(process.argv[3] || path.join(__dirname, "../out", `cursor-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const write = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2));
const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const iso = (value) => value == null ? null : new Date(Number(value)).toISOString();
function stats(db) {
  return db.prepare(`SELECT source, COUNT(*) AS count, MIN(timestamp) AS earliest, MAX(timestamp) AS latest,
    SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) AS tokens,
    SUM(cost_cents) AS costCents FROM usage_events GROUP BY source`).all()
    .map((row) => ({ ...row, earliest: iso(row.earliest), latest: iso(row.latest) }));
}
async function backupExisting() {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "usage-history.sqlite");
  if (fs.existsSync(target)) throw new Error("Backup already exists; refusing to overwrite it");
  const db = new DatabaseSync(HISTORY_DB_PATH, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  const copy = new DatabaseSync(target, { readOnly: true });
  const integrity = copy.prepare("PRAGMA integrity_check").all();
  const before = stats(copy);
  const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  copy.close();
  if (integrity.some((row) => row.integrity_check !== "ok")) throw new Error("Backup integrity check failed");
  const files = [{ name: path.basename(target), sha256: digest(target) }];
  for (const name of fs.readdirSync(APP_DIR)) {
    if (!["settings.json", "history.json", "session.json"].includes(name) && !/^usage-history\.pre-.*\.sqlite$/.test(name)) continue;
    const dest = path.join(directory, name);
    fs.copyFileSync(path.join(APP_DIR, name), dest, fs.constants.COPYFILE_EXCL);
    files.push({ name, sha256: digest(dest) });
  }
  write("backup-manifest.json", { createdAt: new Date().toISOString(), source: HISTORY_DB_PATH, integrity, tables, files, before });
  console.log(JSON.stringify({ directory, integrity, before, files: files.map((file) => file.name) }));
}
function requireBackup() {
  const manifest = read("backup-manifest.json");
  for (const file of manifest.files) {
    if (digest(path.join(directory, file.name)) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.name}`);
  }
  return manifest;
}
async function page(auth, userId, start, end, number = 1) {
  return cursorFetch(auth, "POST", "https://cursor.com/api/dashboard/get-filtered-usage-events", {
    startDate: String(start), endDate: String(end), page: number, pageSize: 100, userId,
  });
}
async function probe() {
  requireBackup();
  const auth = await resolveAuth();
  const me = await cursorFetch(auth, "GET", "https://cursor.com/api/auth/me");
  // Only expose field names and date fields, never authentication material or account identifiers.
  const dates = Object.fromEntries(Object.entries(me || {}).filter(([key]) => /created|date|time/i.test(key)));
  const now = Date.now();
  const result = await page(auth, me.id, 0, now);
  const events = result.usageEventsDisplay || [];
  write("probe.json", { now, accountFields: Object.keys(me || {}), accountDates: dates,
    responseFields: Object.keys(result), total: result.totalUsageEventsCount,
    sampleFields: events[0] ? Object.keys(events[0]) : [],
    sampleTokenFields: events[0]?.tokenUsage ? Object.keys(events[0].tokenUsage) : [],
    firstPageCount: events.length,
    sampleOldest: iso(Math.min(...events.map((event) => Number(event.timestamp)))),
    sampleNewest: iso(Math.max(...events.map((event) => Number(event.timestamp)))) });
  console.log(JSON.stringify(read("probe.json")));
}
async function download() {
  requireBackup();
  const auth = await resolveAuth();
  const me = await cursorFetch(auth, "GET", "https://cursor.com/api/auth/me");
  const end = read("probe.json").now;
  const first = await page(auth, me.id, 0, end);
  const total = Number(first.totalUsageEventsCount);
  if (!Number.isSafeInteger(total) || total < 0 || total > 100_000) throw new Error("Unexpected event count");
  const pageCount = Math.max(1, Math.ceil(total / 100));
  const events = [...(first.usageEventsDisplay || [])];
  for (let number = 2; number <= pageCount; number += 2) {
    const numbers = [number, number + 1].filter((value) => value <= pageCount);
    const responses = await Promise.all(numbers.map((value) => page(auth, me.id, 0, end, value)));
    for (const response of responses) {
      if (Number(response.totalUsageEventsCount) !== total) throw new Error("History changed during pagination; retry with a stable range");
      events.push(...(response.usageEventsDisplay || []));
    }
    console.log(JSON.stringify({ downloaded: events.length, total }));
  }
  if (events.length !== total) throw new Error(`Incomplete download: ${events.length}/${total}`);
  const unique = collapseCursorSnapshots(events);
  const timestamps = unique.map((event) => Number(event.timestamp));
  const summary = { fetchedAt: new Date().toISOString(), accountCreatedAt: me.created_at,
    start: 0, end, total, downloaded: events.length, unique: unique.length,
    earliest: timestamps.length ? iso(Math.min(...timestamps)) : null,
    latest: timestamps.length ? iso(Math.max(...timestamps)) : null };
  write("downloaded-events.json", unique);
  write("download-summary.json", summary);
  console.log(JSON.stringify(summary));
}
async function verifyMonths() {
  requireBackup();
  const auth = await resolveAuth();
  const me = await cursorFetch(auth, "GET", "https://cursor.com/api/auth/me");
  const rows = read("downloaded-events.json");
  const end = read("download-summary.json").end;
  const first = new Date(me.created_at);
  const checks = [];
  for (let start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); start <= end;) {
    const date = new Date(start);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const until = Math.min(next - 1, end);
    const response = await page(auth, me.id, start, until);
    const local = rows.filter((row) => Number(row.timestamp) >= start && Number(row.timestamp) <= until).length;
    const remote = response.totalUsageEventsCount == null && !(response.usageEventsDisplay || []).length
      ? 0 : Number(response.totalUsageEventsCount);
    const check = { month: iso(start).slice(0, 7), downloaded: local, remote, matches: local === remote };
    checks.push(check);
    console.log(JSON.stringify(check));
    if (!check.matches) throw new Error("Monthly count differs from full-history download");
    start = next;
  }
  write("month-verification.json", checks);
}
function historicalEvent(raw, history, pricing) {
  const event = cursorEventToHistory(raw, pricing, [], history);
  const amount = raw.tokenUsage?.totalCents ?? raw.chargedCents;
  const exact = amount != null && amount !== "" && Number.isFinite(Number(amount)) && Number(amount) >= 0;
  if (exact && event.equivalentCostCents == null) {
    event.equivalentCostCents = Number(amount);
    event.equivalentCostLowCents = Number(amount);
    event.equivalentCostHighCents = Number(amount);
    event.pricingStatus = "historical-api-total-only";
  } else if (exact) {
    event.pricingStatus = "historical-api-total-allocated";
  } else {
    // Missing historical prices must not be invented from today's price list.
    for (const key of Object.keys(event)) if (/Cost.*Cents$/.test(key) || key === "costCents") event[key] = null;
    event.pricingStatus = "historical-detail-unavailable";
  }
  return event;
}
function stage() {
  requireBackup();
  const raw = read("downloaded-events.json");
  const source = path.join(directory, "usage-history.sqlite");
  const target = path.join(directory, "staged-history.sqlite");
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const history = new UsageHistory(target);
  try {
    const originals = history.db.prepare("SELECT * FROM usage_events ORDER BY source,event_key").all();
    const existing = new Set(originals.filter((row) => row.source === "cursor").map((row) => row.event_key));
    const newRaw = raw.filter((event) => !existing.has(cursorEventKey(event)));
    const pricing = history.latestPricingSnapshot();
    const events = newRaw.map((event) => historicalEvent(event, history, pricing));
    if (events.some((event) => !Number.isFinite(event.timestamp))) throw new Error("Invalid timestamp");
    const added = history.upsertEvents(events);
    const current = history.db.prepare("SELECT * FROM usage_events WHERE source=? AND event_key=?");
    for (const original of originals) {
      if (JSON.stringify(current.get(original.source, original.event_key)) !== JSON.stringify(original)) throw new Error("Existing record changed during staging");
    }
    const prices = {};
    for (const event of events) prices[event.pricingStatus] = (prices[event.pricingStatus] || 0) + 1;
    const totals = stats(history.db);
    const summary = { added, alreadyPresent: raw.length - added, preservedOriginalRecords: originals.length,
      newTokens: events.reduce((sum, event) => sum + event.input + event.output + event.cacheRead + event.cacheWrite, 0),
      newEquivalentCostCents: events.reduce((sum, event) => sum + (event.equivalentCostCents || 0), 0), prices, totals };
    const integrity = history.db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error("Staged integrity check failed");
    history.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    write("stage-summary.json", summary);
    console.log(JSON.stringify(summary));
  } finally { history.close(); }
  write("staged-manifest.json", { sha256: digest(target) });
}
async function importStaged() {
  requireBackup();
  const checks = read("month-verification.json");
  if (!checks.length || checks.some((check) => !check.matches)) throw new Error("Month verification required");
  const stagedPath = path.join(directory, "staged-history.sqlite");
  if (digest(stagedPath) !== read("staged-manifest.json").sha256) throw new Error("Staging checksum mismatch");
  const immediateBackup = path.join(directory, "usage-history.immediately-before-import.sqlite");
  if (fs.existsSync(immediateBackup)) throw new Error("Import has already been attempted; inspect report first");
  const db = new DatabaseSync(HISTORY_DB_PATH);
  db.exec("PRAGMA busy_timeout=10000");
  try {
    await backup(db, immediateBackup);
    db.prepare("ATTACH DATABASE ? AS staged").run(stagedPath);
    const columns = db.prepare("PRAGMA main.table_info(usage_events)").all().map((row) => row.name);
    const columnList = columns.map((column) => `"${column}"`).join(",");
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = stats(db);
      const originals = db.prepare("SELECT * FROM main.usage_events ORDER BY source,event_key").all();
      const result = db.prepare(`INSERT OR IGNORE INTO main.usage_events (${columnList})
        SELECT ${columnList} FROM staged.usage_events WHERE source='cursor'`).run();
      const current = db.prepare("SELECT * FROM main.usage_events WHERE source=? AND event_key=?");
      for (const original of originals) {
        if (JSON.stringify(current.get(original.source, original.event_key)) !== JSON.stringify(original)) throw new Error("Existing record changed during import");
      }
      const integrity = db.prepare("PRAGMA main.integrity_check").get().integrity_check;
      if (integrity !== "ok") throw new Error("Final integrity check failed");
      const after = stats(db);
      db.exec("COMMIT");
      const report = { importedAt: new Date().toISOString(), added: Number(result.changes),
        before, after, preservedOriginalRecords: originals.length, integrity,
        immediateBackup, backupSha256: digest(immediateBackup) };
      write("import-report.json", report);
      console.log(JSON.stringify(report));
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
async function main() {
  const mode = process.argv[2];
  if (mode === "backup") await backupExisting();
  else if (mode === "probe") await probe();
  else if (mode === "download") await download();
  else if (mode === "verify-months") await verifyMonths();
  else if (mode === "stage") stage();
  else if (mode === "import") await importStaged();
  else throw new Error("Expected backup, probe, download, verify-months, stage or import");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
