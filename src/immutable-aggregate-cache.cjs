// Only immutable history rows can be reused. Compare the selected rows, rather
// than rounding time: rolling-window boundaries and corrected rows invalidate
// immediately, even if the event count stays the same.
class ImmutableAggregateCache {
  constructor(limit = 32) {
    this.limit = limit;
    this.entries = [];
  }

  get(key, rows, build) {
    const index = this.entries.findIndex(entry => entry.key === key && entry.rows.length === rows.length
      && entry.rows.every((row, i) => row === rows[i]));
    if (index >= 0) {
      const [entry] = this.entries.splice(index, 1);
      this.entries.push(entry);
      return structuredClone(entry.value);
    }
    const value = build();
    if (rows.every(row => Object.isFrozen(row) && (!row.tokenUsage || Object.isFrozen(row.tokenUsage)))) {
      this.entries.push({ key, rows: rows.slice(), value: structuredClone(value) });
      if (this.entries.length > this.limit) this.entries.shift();
    }
    return value;
  }
}

module.exports = { ImmutableAggregateCache };
