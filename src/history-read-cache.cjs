// Connection-local caches: TEMP triggers observe real changes (including direct
// SQL and rolled-back transactions) without adding tables to the history file.
class HistoryReadCache {
  constructor(db) {
    this.db = db;
    this.entries = new Map();
    this.versionStatement = db.prepare("PRAGMA data_version");
    this.version = this.versionStatement.get().data_version;
    if (typeof db.function !== "function") return;
    db.function("widget_invalidate_reads", (kind, source) => {
      this.invalidate(kind, source);
      return 0;
    });
    for (const [table, kind, source] of [
      ["usage_events", "events", "source"],
      ["quota_samples", "quota", "source"],
      ["codex_quota_observations", "quota", null],
      ["pricing_snapshots", "pricing", null],
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      const changed = columns.map(name => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        return `OLD.${quoted} IS NOT NEW.${quoted}`;
      }).join(" OR ");
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const row = operation === "DELETE" ? "OLD" : "NEW";
        const sourceSql = source ? `${row}.${source}` : table === "codex_quota_observations" ? "'codex'" : "NULL";
        db.exec(`CREATE TEMP TRIGGER widget_reads_${table}_${operation}
          AFTER ${operation} ON main.${table}
          ${operation === "UPDATE" ? `WHEN ${changed}` : ""}
          BEGIN
            SELECT widget_invalidate_reads('${kind}', ${sourceSql});
            ${operation === "UPDATE" && source ? `SELECT widget_invalidate_reads('${kind}', OLD.${source});` : ""}
          END`);
      }
    }
    // Switching from legacy quota samples to provenance observations changes
    // the meaning of the quota query even when neither table changed.
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TEMP TRIGGER widget_reads_provenance_${operation}
        AFTER ${operation} ON main.app_cache
        WHEN ${row}.key = 'codex-provenance-samples-v1'
        BEGIN SELECT widget_invalidate_reads('quota', NULL); END`);
    }
  }

  invalidate(kind, source) {
    for (const [key, entry] of this.entries) {
      if (entry.kind === kind && (source == null || !entry.sources || entry.sources.includes(source))) this.entries.delete(key);
    }
  }

  get(kind, key, sources, read) {
    // Never retain uncommitted rows: rollback itself does not fire triggers.
    // Older SQLite runtimes without this property use uncached reads safely.
    if (this.db.isTransaction !== false) return read();
    const version = this.versionStatement.get().data_version;
    if (version !== this.version) {
      this.entries.clear();
      this.version = version;
    }
    const cacheKey = `${kind}:${key}`;
    if (!this.entries.has(cacheKey)) {
      const value = read();
      if ((kind === "events" || kind === "quota") && Array.isArray(value)) value.forEach(Object.freeze);
      // Limit unusual user-selected source combinations / pricing IDs.
      if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(cacheKey, { kind, sources, value });
    }
    return this.entries.get(cacheKey).value;
  }
}

module.exports = { HistoryReadCache };
