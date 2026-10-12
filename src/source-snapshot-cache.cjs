class SourceSnapshotCache {
  constructor() {
    this.results = new Map();
    this.pricingKey = null;
  }

  async collect(builders, { sources = null, pricingKey = null } = {}) {
    if (pricingKey !== this.pricingKey) {
      this.results.clear();
      this.pricingKey = pricingKey;
    }
    const selected = sources == null ? null : new Set(sources);
    return Promise.all(Object.entries(builders).map(async ([source, build]) => {
      if (selected && !selected.has(source) && this.results.has(source)) return this.results.get(source);
      let result;
      try { result = { status: "fulfilled", value: await build() }; }
      catch (reason) { result = { status: "rejected", reason }; }
      this.results.set(source, result);
      return result;
    }));
  }
}

module.exports = { SourceSnapshotCache };
