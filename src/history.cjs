const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CURSOR_EVENT_KEY_PREFIX, cursorEventKeyFromLegacy } = require("./identity.cjs");

const APP_DIR = path.join(os.homedir(), "AppData", "Roaming", "cursor-usage-widget");
const HISTORY_DB_PATH = path.join(APP_DIR, "usage-history.sqlite");
const LEGACY_HISTORY_PATH = path.join(APP_DIR, "history.json");

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function upsertCost(column) {
  return `CASE
    WHEN usage_events.pricing_status = 'unavailable' THEN excluded.${column}
    WHEN excluded.tier_source = 'response' AND COALESCE(usage_events.tier_source, '') != 'response' THEN COALESCE(excluded.${column}, usage_events.${column})
    ELSE COALESCE(usage_events.${column}, excluded.${column})
  END`;
}

function eventFilter({ sources, query = "" } = {}) {
  const sourceList = Array.isArray(sources) ? sources.filter(Boolean) : sources ? [sources] : [];
  const clauses = ["1 = 1"];
  const params = [];
  if (sourceList.length) {
    clauses.push(`source IN (${sourceList.map(() => "?").join(",")})`);
    params.push(...sourceList);
  }
  const needle = String(query || "").trim();
  if (needle) {
    const like = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    clauses.push("(model LIKE ? ESCAPE '\\' OR IFNULL(effort, '') LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const where = clauses.join(" AND ");
  return { where, params };
}

function eventFromRow(row) {
  return {
    source: row.source,
    eventKey: row.event_key,
    timestamp: Number(row.timestamp),
    model: row.model,
    effort: row.effort,
    fast: row.fast === 1,
    fastKnown: row.fast != null,
    pool: row.pool,
    input: Number(row.input_tokens) || 0,
    output: Number(row.output_tokens) || 0,
    cacheRead: Number(row.cache_read_tokens) || 0,
    cacheWrite: Number(row.cache_write_tokens) || 0,
    reasoning: Number(row.reasoning_tokens) || 0,
    equivalentCostCents: row.equivalent_cost_cents,
    inputCostCents: row.input_cost_cents,
    cacheReadCostCents: row.cache_read_cost_cents,
    cacheWriteCostCents: row.cache_write_cost_cents,
    outputCostCents: row.output_cost_cents,
  };
}

class UsageHistory {
  constructor(dbPath = HISTORY_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS usage_events (
        source TEXT NOT NULL,
        event_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        fast INTEGER,
        pool TEXT,
        service_tier TEXT,
        tier_source TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_cents REAL,
        input_cost_cents REAL,
        cache_read_cost_cents REAL,
        cache_write_cost_cents REAL,
        cache_cost_cents REAL,
        output_cost_cents REAL,
        equivalent_cost_cents REAL,
        equivalent_cost_low_cents REAL,
        equivalent_cost_high_cents REAL,
        quota_equivalent_cost_cents REAL,
        quota_equivalent_cost_low_cents REAL,
        quota_equivalent_cost_high_cents REAL,
        pricing_snapshot_id INTEGER,
        pricing_status TEXT,
        request_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (source, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_events_source_time ON usage_events(source, timestamp);
      CREATE TABLE IF NOT EXISTS quota_samples (
        source TEXT NOT NULL,
        pool TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        used_percent REAL,
        window_minutes INTEGER,
        resets_at INTEGER,
        starts_at INTEGER,
        PRIMARY KEY (source, pool, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_samples_time ON quota_samples(source, timestamp);
      CREATE TABLE IF NOT EXISTS app_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pricing_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fetched_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_urls TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
    this.ensureUsageColumns();
    if (!this.db.prepare("PRAGMA table_info(quota_samples)").all().some((column) => column.name === "starts_at")) {
      this.db.exec("ALTER TABLE quota_samples ADD COLUMN starts_at INTEGER");
    }
    if (!this.db.prepare("PRAGMA table_info(quota_samples)").all().some((column) => column.name === "plan_type")) {
      this.db.exec("ALTER TABLE quota_samples ADD COLUMN plan_type TEXT");
    }
    this.migrateCursorSnapshotEvents();
    this.insertEvent = this.db.prepare(`
      INSERT INTO usage_events (
        source, event_key, timestamp, model, effort, fast, pool, service_tier, tier_source,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, cost_cents, input_cost_cents, cache_read_cost_cents,
        cache_write_cost_cents, cache_cost_cents,
        output_cost_cents, equivalent_cost_cents, equivalent_cost_low_cents,
        equivalent_cost_high_cents, quota_equivalent_cost_cents,
        quota_equivalent_cost_low_cents, quota_equivalent_cost_high_cents,
        pricing_snapshot_id, pricing_status, request_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, event_key) DO UPDATE SET
        timestamp = CASE
          WHEN excluded.source = 'codex' THEN MIN(usage_events.timestamp, excluded.timestamp)
          ELSE excluded.timestamp
        END,
        model = excluded.model,
        effort = excluded.effort,
        fast = CASE
          WHEN excluded.tier_source = 'response' THEN excluded.fast
          WHEN usage_events.tier_source = 'response' THEN usage_events.fast
          ELSE COALESCE(excluded.fast, usage_events.fast)
        END,
        pool = COALESCE(excluded.pool, usage_events.pool),
        service_tier = CASE
          WHEN excluded.tier_source = 'response' THEN excluded.service_tier
          WHEN usage_events.tier_source = 'response' THEN usage_events.service_tier
          ELSE COALESCE(excluded.service_tier, usage_events.service_tier)
        END,
        tier_source = CASE
          WHEN excluded.tier_source = 'response' THEN 'response'
          WHEN usage_events.tier_source = 'response' THEN 'response'
          ELSE COALESCE(excluded.tier_source, usage_events.tier_source)
        END,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cost_cents = COALESCE(usage_events.cost_cents, excluded.cost_cents),
        input_cost_cents = ${upsertCost("input_cost_cents")},
        cache_read_cost_cents = ${upsertCost("cache_read_cost_cents")},
        cache_write_cost_cents = ${upsertCost("cache_write_cost_cents")},
        cache_cost_cents = ${upsertCost("cache_cost_cents")},
        output_cost_cents = ${upsertCost("output_cost_cents")},
        equivalent_cost_cents = ${upsertCost("equivalent_cost_cents")},
        equivalent_cost_low_cents = ${upsertCost("equivalent_cost_low_cents")},
        equivalent_cost_high_cents = ${upsertCost("equivalent_cost_high_cents")},
        quota_equivalent_cost_cents = ${upsertCost("quota_equivalent_cost_cents")},
        quota_equivalent_cost_low_cents = ${upsertCost("quota_equivalent_cost_low_cents")},
        quota_equivalent_cost_high_cents = ${upsertCost("quota_equivalent_cost_high_cents")},
        pricing_snapshot_id = CASE
          WHEN usage_events.pricing_status IS NULL OR usage_events.pricing_status = 'unavailable'
            THEN COALESCE(excluded.pricing_snapshot_id, usage_events.pricing_snapshot_id)
          ELSE COALESCE(usage_events.pricing_snapshot_id, excluded.pricing_snapshot_id)
        END,
        pricing_status = CASE
          WHEN usage_events.pricing_status IS NULL OR usage_events.pricing_status = 'unavailable'
            THEN excluded.pricing_status
          ELSE COALESCE(usage_events.pricing_status, excluded.pricing_status)
        END,
        request_count = excluded.request_count
    `);
    this.insertQuota = this.db.prepare(`
      INSERT INTO quota_samples (source, pool, bucket, timestamp, used_percent, window_minutes, resets_at, starts_at, plan_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, pool, bucket) DO UPDATE SET
        timestamp = excluded.timestamp,
        used_percent = excluded.used_percent,
        window_minutes = excluded.window_minutes,
        plan_type = COALESCE(excluded.plan_type, quota_samples.plan_type),
        starts_at = CASE WHEN quota_samples.resets_at IS excluded.resets_at
          THEN COALESCE(excluded.starts_at, quota_samples.starts_at) ELSE excluded.starts_at END,
        resets_at = excluded.resets_at
    `);
    this.cursorEventProgress = this.db.prepare(`
      SELECT input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS total_tokens,
             COALESCE(cost_cents, equivalent_cost_cents, 0) AS total_cost
      FROM usage_events WHERE source = 'cursor' AND event_key = ?
    `);
    this.deleteCursorEvent = this.db.prepare("DELETE FROM usage_events WHERE source = 'cursor' AND event_key = ?");
    this.unifyCodexDollarEquivalent();
    this.migrateLegacyHistory();
  }

  ensureUsageColumns() {
    const existing = new Set(this.db.prepare("PRAGMA table_info(usage_events)").all().map((row) => row.name));
    const columns = {
      input_cost_cents: "REAL",
      cache_read_cost_cents: "REAL",
      cache_write_cost_cents: "REAL",
      cache_cost_cents: "REAL",
      output_cost_cents: "REAL",
      equivalent_cost_cents: "REAL",
      equivalent_cost_low_cents: "REAL",
      equivalent_cost_high_cents: "REAL",
      pricing_snapshot_id: "INTEGER",
      pricing_status: "TEXT",
      pool: "TEXT",
      service_tier: "TEXT",
      tier_source: "TEXT",
      quota_equivalent_cost_cents: "REAL",
      quota_equivalent_cost_low_cents: "REAL",
      quota_equivalent_cost_high_cents: "REAL",
    };
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      UPDATE usage_events SET pool = CASE
        WHEN source = 'codex' THEN 'codex'
        WHEN lower(model) LIKE 'cursor-grok%' OR lower(model) LIKE 'grok-4%'
          OR lower(model) LIKE 'composer%' OR lower(model) LIKE 'vega%'
          OR lower(model) LIKE 'default%' THEN 'cursor-models'
        WHEN source = 'cursor' THEN 'other-models'
        ELSE pool
      END
      WHERE pool IS NULL
    `);
  }

  migrateCursorSnapshotEvents({ force = false } = {}) {
    const markerKey = "cursor-stable-event-key-v2";
    const previous = this.loadCache(markerKey);
    if (!force && previous) return previous.value;
    const rows = this.db.prepare(`
      SELECT rowid AS row_id, event_key, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens,
             COALESCE(cost_cents, equivalent_cost_cents, 0) AS total_cost
      FROM usage_events WHERE source = 'cursor'
    `).all();
    const legacyRows = rows.filter((row) => !String(row.event_key).startsWith(CURSOR_EVENT_KEY_PREFIX));
    if (!legacyRows.length) {
      const result = { migrated: 0, removed: 0, duplicateGroups: 0, backupPath: null };
      this.saveCache(markerKey, result);
      return result;
    }
    const groups = new Map();
    for (const row of rows) {
      const targetKey = cursorEventKeyFromLegacy(row.event_key);
      if (!targetKey) continue;
      if (!groups.has(targetKey)) groups.set(targetKey, []);
      groups.get(targetKey).push(row);
    }
    const winner = (items) => items.reduce((best, row) => {
      if (!best) return row;
      const rowTokens = Number(row.input_tokens) + Number(row.output_tokens) + Number(row.cache_read_tokens) + Number(row.cache_write_tokens);
      const bestTokens = Number(best.input_tokens) + Number(best.output_tokens) + Number(best.cache_read_tokens) + Number(best.cache_write_tokens);
      if (rowTokens !== bestTokens) return rowTokens > bestTokens ? row : best;
      if (Number(row.total_cost) !== Number(best.total_cost)) return Number(row.total_cost) > Number(best.total_cost) ? row : best;
      return Number(row.row_id) > Number(best.row_id) ? row : best;
    }, null);
    const backupPath = this.dbPath === ":memory:" ? null : path.join(
      path.dirname(this.dbPath),
      `usage-history.pre-cursor-dedupe-${Date.now()}.sqlite`
    );
    if (backupPath) {
      const escaped = backupPath.replaceAll("'", "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);
    }
    let removed = 0;
    let duplicateGroups = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [targetKey, items] of groups) {
        const keep = winner(items);
        if (items.length > 1) duplicateGroups += 1;
        for (const row of items) {
          if (row.row_id === keep.row_id) continue;
          this.db.prepare("DELETE FROM usage_events WHERE rowid = ?").run(row.row_id);
          removed += 1;
        }
        this.db.prepare("UPDATE usage_events SET event_key = ? WHERE rowid = ?").run(targetKey, keep.row_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const result = { migrated: legacyRows.length, removed, duplicateGroups, backupPath };
    this.saveCache(markerKey, result);
    return result;
  }

  migrateCodexCumulativeEvents(events) {
    const mappings = new Map();
    for (const event of events || []) {
      if (event?.source !== "codex" || !String(event.eventKey || "").startsWith("codex:v2:")) continue;
      for (const legacyKey of event.legacyEventKeys || []) {
        if (legacyKey && legacyKey !== event.eventKey) mappings.set(String(legacyKey), String(event.eventKey));
      }
    }
    if (!mappings.size) return { migrated: 0, removed: 0, duplicateGroups: 0, backupPath: null };

    const selectLegacy = this.db.prepare(`
      SELECT rowid AS row_id, event_key, timestamp
      FROM usage_events
      WHERE source = 'codex' AND event_key = ?
    `);
    const groups = new Map();
    for (const [legacyKey, targetKey] of mappings) {
      const row = selectLegacy.get(legacyKey);
      if (!row) continue;
      if (!groups.has(targetKey)) groups.set(targetKey, []);
      groups.get(targetKey).push(row);
    }
    if (!groups.size) return { migrated: 0, removed: 0, duplicateGroups: 0, backupPath: null };

    const backupPath = this.dbPath === ":memory:" ? null : path.join(
      path.dirname(this.dbPath),
      `usage-history.pre-codex-dedupe-${Date.now()}.sqlite`
    );
    if (backupPath) {
      const escaped = backupPath.replaceAll("'", "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);
    }

    const selectTarget = this.db.prepare(`
      SELECT rowid AS row_id FROM usage_events
      WHERE source = 'codex' AND event_key = ?
    `);
    const deleteRow = this.db.prepare("DELETE FROM usage_events WHERE rowid = ?");
    const updateKey = this.db.prepare("UPDATE usage_events SET event_key = ? WHERE rowid = ?");
    let migrated = 0;
    let removed = 0;
    let duplicateGroups = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [targetKey, rows] of groups) {
        const target = selectTarget.get(targetKey);
        migrated += rows.length;
        if (rows.length > 1 || target) duplicateGroups += 1;
        if (target) {
          for (const row of rows) {
            deleteRow.run(row.row_id);
            removed += 1;
          }
          continue;
        }
        const keep = rows.reduce((best, row) => !best || Number(row.timestamp) < Number(best.timestamp) ? row : best, null);
        for (const row of rows) {
          if (row.row_id === keep.row_id) continue;
          deleteRow.run(row.row_id);
          removed += 1;
        }
        updateKey.run(targetKey, keep.row_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { migrated, removed, duplicateGroups, backupPath };
  }

  upsertEvents(events) {
    if (!Array.isArray(events) || !events.length) return 0;
    let count = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (!event?.source || !event?.eventKey || !Number.isFinite(Number(event.timestamp))) continue;
        if (String(event.source) === "cursor") {
          const existing = this.cursorEventProgress.get(String(event.eventKey));
          if (existing) {
            const incomingTokens = finite(event.input) + finite(event.output) + finite(event.cacheRead) + finite(event.cacheWrite);
            const incomingCost = finite(event.costCents ?? event.equivalentCostCents);
            const hasMoreProgress = incomingTokens > finite(existing.total_tokens)
              || (incomingTokens === finite(existing.total_tokens) && incomingCost > finite(existing.total_cost) + 1e-9);
            if (!hasMoreProgress) continue;
            this.deleteCursorEvent.run(String(event.eventKey));
          }
        }
        this.insertEvent.run(
          String(event.source),
          String(event.eventKey),
          Math.trunc(Number(event.timestamp)),
          String(event.model || "unknown"),
          event.effort == null ? null : String(event.effort),
          event.fastKnown === false ? null : event.fast ? 1 : 0,
          event.pool == null ? null : String(event.pool),
          event.serviceTier == null ? null : String(event.serviceTier),
          event.tierSource == null ? null : String(event.tierSource),
          Math.max(0, Math.trunc(finite(event.input))),
          Math.max(0, Math.trunc(finite(event.output))),
          Math.max(0, Math.trunc(finite(event.cacheRead))),
          Math.max(0, Math.trunc(finite(event.cacheWrite))),
          Math.max(0, Math.trunc(finite(event.reasoning))),
          event.costCents == null ? null : finite(event.costCents),
          event.inputCostCents == null ? null : finite(event.inputCostCents),
          event.cacheReadCostCents == null ? null : finite(event.cacheReadCostCents),
          event.cacheWriteCostCents == null ? null : finite(event.cacheWriteCostCents),
          event.cacheCostCents == null ? null : finite(event.cacheCostCents),
          event.outputCostCents == null ? null : finite(event.outputCostCents),
          event.equivalentCostCents == null ? null : finite(event.equivalentCostCents),
          event.equivalentCostLowCents == null ? null : finite(event.equivalentCostLowCents),
          event.equivalentCostHighCents == null ? null : finite(event.equivalentCostHighCents),
          event.quotaEquivalentCostCents == null ? null : finite(event.quotaEquivalentCostCents),
          event.quotaEquivalentCostLowCents == null ? null : finite(event.quotaEquivalentCostLowCents),
          event.quotaEquivalentCostHighCents == null ? null : finite(event.quotaEquivalentCostHighCents),
          event.pricingSnapshotId == null ? null : Math.trunc(finite(event.pricingSnapshotId)),
          event.pricingStatus == null ? null : String(event.pricingStatus),
          Math.max(1, Math.trunc(finite(event.count, 1)))
        );
        count += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return count;
  }

  getEvents({ sources, start = 0, end = Date.now() + 60_000 } = {}) {
    const sourceList = Array.isArray(sources) ? sources.filter(Boolean) : sources ? [sources] : [];
    const whereSource = sourceList.length ? ` AND source IN (${sourceList.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM usage_events WHERE timestamp >= ? AND timestamp < ?${whereSource} ORDER BY timestamp ASC`)
      .all(Math.trunc(start), Math.trunc(end), ...sourceList);
    return rows.map((row) => ({
      source: row.source,
      eventKey: row.event_key,
      timestamp: row.timestamp,
      model: row.model,
      effort: row.effort,
      fast: row.fast === 1,
      fastKnown: row.fast != null,
      pool: row.pool,
      serviceTier: row.service_tier,
      tierSource: row.tier_source,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
      costCents: row.cost_cents,
      inputCostCents: row.input_cost_cents,
      cacheReadCostCents: row.cache_read_cost_cents,
      cacheWriteCostCents: row.cache_write_cost_cents,
      cacheCostCents: row.cache_cost_cents,
      outputCostCents: row.output_cost_cents,
      equivalentCostCents: row.equivalent_cost_cents,
      equivalentCostLowCents: row.equivalent_cost_low_cents,
      equivalentCostHighCents: row.equivalent_cost_high_cents,
      quotaEquivalentCostCents: row.quota_equivalent_cost_cents,
      quotaEquivalentCostLowCents: row.quota_equivalent_cost_low_cents,
      quotaEquivalentCostHighCents: row.quota_equivalent_cost_high_cents,
      pricingSnapshotId: row.pricing_snapshot_id,
      pricingStatus: row.pricing_status,
      count: row.request_count,
    }));
  }

  getUnpricedEvents(limit = 20_000) {
    const rows = this.db.prepare(`
      SELECT * FROM usage_events
      WHERE pricing_status = 'unavailable'
         OR (equivalent_cost_cents IS NULL AND pricing_status IS NULL)
         OR (source = 'codex' AND quota_equivalent_cost_cents IS NULL)
      ORDER BY timestamp ASC LIMIT ?
    `).all(Math.max(1, Math.trunc(finite(limit, 20_000))));
    return rows.map((row) => ({
      source: row.source,
      eventKey: row.event_key,
      timestamp: row.timestamp,
      model: row.model,
      effort: row.effort,
      fast: row.fast === 1,
      fastKnown: row.fast != null,
      pool: row.pool,
      serviceTier: row.service_tier,
      tierSource: row.tier_source,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
      costCents: row.cost_cents,
      cacheCostCents: row.cache_cost_cents,
      equivalentCostCents: row.equivalent_cost_cents,
      pricingSnapshotId: row.pricing_snapshot_id,
      count: row.request_count,
    }));
  }

  getEventsNeedingCacheBreakdown(limit = 20_000) {
    const rows = this.db.prepare(`
      SELECT * FROM usage_events
      WHERE cache_cost_cents IS NOT NULL
        AND (cache_read_cost_cents IS NULL OR cache_write_cost_cents IS NULL)
        AND pricing_snapshot_id IS NOT NULL
      ORDER BY timestamp ASC LIMIT ?
    `).all(Math.max(1, Math.trunc(finite(limit, 20_000))));
    return rows.map((row) => ({
      source: row.source,
      eventKey: row.event_key,
      timestamp: row.timestamp,
      model: row.model,
      effort: row.effort,
      fast: row.fast === 1,
      fastKnown: row.fast != null,
      pool: row.pool,
      serviceTier: row.service_tier,
      tierSource: row.tier_source,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      reasoning: row.reasoning_tokens,
      costCents: row.cost_cents,
      cacheCostCents: row.cache_cost_cents,
      equivalentCostCents: row.equivalent_cost_cents,
      pricingSnapshotId: row.pricing_snapshot_id,
      count: row.request_count,
    }));
  }

  unifyCodexDollarEquivalent() {
    const result = this.db.prepare(`
      UPDATE usage_events SET
        input_cost_cents = CASE
          WHEN equivalent_cost_cents > 0 THEN input_cost_cents * quota_equivalent_cost_cents / equivalent_cost_cents
          ELSE input_cost_cents
        END,
        cache_read_cost_cents = CASE
          WHEN equivalent_cost_cents > 0 THEN cache_read_cost_cents * quota_equivalent_cost_cents / equivalent_cost_cents
          ELSE cache_read_cost_cents
        END,
        cache_write_cost_cents = CASE
          WHEN equivalent_cost_cents > 0 THEN cache_write_cost_cents * quota_equivalent_cost_cents / equivalent_cost_cents
          ELSE cache_write_cost_cents
        END,
        cache_cost_cents = CASE
          WHEN equivalent_cost_cents > 0 THEN cache_cost_cents * quota_equivalent_cost_cents / equivalent_cost_cents
          ELSE cache_cost_cents
        END,
        output_cost_cents = CASE
          WHEN equivalent_cost_cents > 0 THEN output_cost_cents * quota_equivalent_cost_cents / equivalent_cost_cents
          ELSE output_cost_cents
        END,
        equivalent_cost_cents = quota_equivalent_cost_cents,
        equivalent_cost_low_cents = quota_equivalent_cost_low_cents,
        equivalent_cost_high_cents = quota_equivalent_cost_high_cents,
        pricing_status = CASE
          WHEN pricing_status LIKE '%credit-multiplier%' THEN pricing_status
          ELSE COALESCE(pricing_status, 'official-rate') || '-credit-multiplier'
        END
      WHERE source = 'codex'
        AND quota_equivalent_cost_cents IS NOT NULL
        AND (
          equivalent_cost_cents IS NULL
          OR ABS(equivalent_cost_cents - quota_equivalent_cost_cents) > 0.000001
          OR ABS(COALESCE(equivalent_cost_low_cents, -1) - COALESCE(quota_equivalent_cost_low_cents, -1)) > 0.000001
          OR ABS(COALESCE(equivalent_cost_high_cents, -1) - COALESCE(quota_equivalent_cost_high_cents, -1)) > 0.000001
        )
    `).run();
    return Number(result.changes || 0);
  }

  savePricingSnapshot(snapshot) {
    const result = this.db.prepare(`
      INSERT INTO pricing_snapshots (fetched_at, status, source_urls, data_json)
      VALUES (?, ?, ?, ?)
    `).run(
      Math.trunc(finite(snapshot?.fetchedAt, Date.now())),
      String(snapshot?.status || "unknown"),
      JSON.stringify(snapshot?.sourceUrls || []),
      JSON.stringify({ ...snapshot, id: undefined }),
    );
    return Number(result.lastInsertRowid);
  }

  latestPricingSnapshot() {
    const row = this.db.prepare("SELECT id, data_json FROM pricing_snapshots ORDER BY id DESC LIMIT 1").get();
    if (!row) return null;
    try {
      return { ...JSON.parse(row.data_json), id: Number(row.id) };
    } catch {
      return null;
    }
  }

  pricingSnapshot(id) {
    if (id == null) return null;
    const row = this.db.prepare("SELECT id, data_json FROM pricing_snapshots WHERE id = ?").get(Math.trunc(finite(id)));
    if (!row) return null;
    try {
      return { ...JSON.parse(row.data_json), id: Number(row.id) };
    } catch {
      return null;
    }
  }

  getEvent(source, eventKey) {
    const row = this.db.prepare("SELECT * FROM usage_events WHERE source = ? AND event_key = ?").get(String(source), String(eventKey));
    if (!row) return null;
    return this.getEvents({ sources: source, start: Number(row.timestamp), end: Number(row.timestamp) + 1 })
      .find((event) => event.eventKey === String(eventKey)) || null;
  }

  latestTimestamp(source) {
    const row = this.db.prepare("SELECT MAX(timestamp) AS timestamp FROM usage_events WHERE source = ?").get(source);
    return row?.timestamp == null ? null : Number(row.timestamp);
  }

  getQuotaConsumption({ source = "codex", start = 0, end = Date.now() + 1 } = {}) {
    // The month planner needs timestamps and quota costs, not full token/model rows.
    return this.db.prepare(`SELECT timestamp, quota_equivalent_cost_cents
      FROM usage_events WHERE source = ? AND timestamp >= ? AND timestamp < ?
        AND (source != 'codex' OR lower(model) NOT LIKE '%spark%') ORDER BY timestamp ASC
    `).all(source, start, end).map((row) => ({
      source, timestamp: Number(row.timestamp),
      quotaEquivalentCostCents: row.quota_equivalent_cost_cents == null ? null : Number(row.quota_equivalent_cost_cents),
    }));
  }

  getQuotaSamples({ source, start = 0, end = Number.MAX_SAFE_INTEGER } = {}) {
    const samples = this.db.prepare(`
      SELECT source, pool, bucket, timestamp, used_percent, window_minutes, resets_at, starts_at, plan_type
      FROM quota_samples
      WHERE timestamp >= ? AND timestamp < ? ${source ? "AND source = ?" : ""}
      ORDER BY timestamp ASC
    `).all(start, end, ...(source ? [source] : [])).map((row) => ({
      source: row.source,
      pool: row.pool,
      bucket: Number(row.bucket),
      timestamp: Number(row.timestamp),
      usedPercent: row.used_percent == null ? null : Number(row.used_percent),
      windowMinutes: row.window_minutes == null ? null : Number(row.window_minutes),
      resetsAt: row.resets_at == null ? null : Number(row.resets_at),
      startsAt: row.starts_at == null ? null : Number(row.starts_at),
      planType: row.plan_type || null,
    }));
    // Recovered main-pool session observations supersede legacy snapshots in
    // their covered interval; those old rows could have come from Spark.
    const recovered = samples.filter((s) => s.source === "codex" && s.planType);
    const first = recovered[0]?.timestamp ?? Infinity;
    const last = recovered.at(-1)?.timestamp ?? -Infinity;
    return samples.filter((s) => s.source !== "codex" || s.planType || s.timestamp < first || s.timestamp > last);
  }

  queryEvents({ sources, query = "", offset = 0, limit = 40 } = {}) {
    const { where, params } = eventFilter({ sources, query });
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE ${where}`).get(...params)?.count || 0);
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 40)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const rows = this.db.prepare(`
      SELECT * FROM usage_events
      WHERE ${where}
      ORDER BY timestamp DESC, source ASC, event_key ASC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    return {
      total,
      offset: safeOffset,
      limit: safeLimit,
      events: rows.map(eventFromRow),
    };
  }

  *iterateEvents(options = {}) {
    const { where, params } = eventFilter(options);
    const statement = this.db.prepare(`SELECT * FROM usage_events WHERE ${where}
      ORDER BY timestamp DESC, source ASC, event_key ASC`);
    for (const row of statement.iterate(...params)) yield eventFromRow(row);
  }

  listPricingSnapshots(limit = 24) {
    return this.db.prepare(`
      SELECT id, fetched_at, status
      FROM pricing_snapshots
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(1, Math.trunc(finite(limit, 24)))).map((row) => ({
      id: Number(row.id),
      fetchedAt: Number(row.fetched_at),
      status: row.status,
    }));
  }

  quarantineCodexQuotaSamples(samples = []) {
    if (!samples.length) return 0;
    // Older scanners persisted separate pools without their limit ID. Only
    // quarantine observations matched to excluded source records, retaining
    // the original rows for recovery. Never infer a bad row from a low percent.
    const match = `source = 'codex' AND timestamp = ? AND window_minutes = ?
      AND used_percent = ? AND resets_at = ?`;
    this.db.exec("SAVEPOINT quarantine_codex_quota");
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS excluded_codex_quota_samples AS
        SELECT * FROM quota_samples WHERE 0`);
      const archive = this.db.prepare(`INSERT INTO excluded_codex_quota_samples
        SELECT * FROM quota_samples WHERE ${match}`);
      const remove = this.db.prepare(`DELETE FROM quota_samples WHERE ${match}`);
      let removed = 0;
      for (const sample of samples) {
        const values = [sample.timestamp, sample.windowMinutes, sample.usedPercent, sample.resetsAt];
        if (!values.every((value) => value != null && Number.isFinite(Number(value)))) continue;
        archive.run(...values);
        removed += Number(remove.run(...values).changes);
      }
      this.db.exec("RELEASE quarantine_codex_quota");
      return removed;
    } catch (error) {
      this.db.exec("ROLLBACK TO quarantine_codex_quota; RELEASE quarantine_codex_quota");
      throw error;
    }
  }

  saveQuotaSample(sample) {
    if (!sample?.source || !sample?.pool || !Number.isFinite(Number(sample.timestamp))) return;
    const timestamp = Math.trunc(Number(sample.timestamp));
    // Keep reset boundaries even when both observations fall in one five-minute bucket.
    const bucket = sample.source === "codex" ? timestamp : Math.floor(timestamp / 300_000) * 300_000;
    this.insertQuota.run(
      String(sample.source),
      String(sample.pool),
      bucket,
      timestamp,
      sample.usedPercent == null ? null : finite(sample.usedPercent),
      sample.windowMinutes == null ? null : Math.trunc(finite(sample.windowMinutes)),
      sample.resetsAt == null ? null : Math.trunc(finite(sample.resetsAt)),
      sample.startsAt == null ? null : Math.trunc(finite(sample.startsAt)),
      sample.planType || null,
    );
  }

  saveCache(key, value) {
    this.db.prepare(`
      INSERT INTO app_cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(key), JSON.stringify(value), Date.now());
  }

  loadCache(key) {
    const row = this.db.prepare("SELECT value, updated_at FROM app_cache WHERE key = ?").get(String(key));
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value), updatedAt: Number(row.updated_at) };
    } catch {
      return null;
    }
  }

  stats() {
    const overall = this.db.prepare("SELECT COUNT(*) AS count, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM usage_events").get();
    const sources = this.db.prepare("SELECT source, COUNT(*) AS count, MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM usage_events GROUP BY source").all();
    return {
      path: this.dbPath,
      count: Number(overall?.count || 0),
      earliest: overall?.earliest == null ? null : Number(overall.earliest),
      latest: overall?.latest == null ? null : Number(overall.latest),
      sources: Object.fromEntries(sources.map((row) => [row.source, {
        count: Number(row.count),
        earliest: Number(row.earliest),
        latest: Number(row.latest),
      }])),
    };
  }

  migrateLegacyHistory() {
    if (this.loadCache("legacy-history-migrated")) return;
    try {
      const history = JSON.parse(fs.readFileSync(LEGACY_HISTORY_PATH, "utf8"));
      for (const sample of history.samples || []) {
        const timestamp = Number(sample.t);
        if (!Number.isFinite(timestamp)) continue;
        if (Number.isFinite(Number(sample.autoPct))) {
          this.saveQuotaSample({ source: "cursor", pool: "cursor-models", timestamp, usedPercent: Number(sample.autoPct) });
        }
        if (Number.isFinite(Number(sample.apiPct))) {
          this.saveQuotaSample({ source: "cursor", pool: "other-models", timestamp, usedPercent: Number(sample.apiPct) });
        }
      }
    } catch {
      // Older installs may not have the JSON snapshot history.
    }
    this.saveCache("legacy-history-migrated", { at: Date.now() });
  }

  close() {
    this.db.close();
  }
}

let singleton;

function getHistory() {
  if (!singleton) singleton = new UsageHistory();
  return singleton;
}

module.exports = { APP_DIR, HISTORY_DB_PATH, UsageHistory, getHistory };
