// Merge changes while a refresh is running; background file events obey the
// configured poll interval. Manual refreshes run immediately after active work.
class RefreshScheduler {
  constructor({ run, interval, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.run = run;
    this.interval = interval;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.lastStartedAt = -Infinity;
    this.pending = null;
    this.running = false;
    this.timer = null;
    this.closed = false;
  }

  request({ sources = null, forcePricing = false, background = false } = {}) {
    if (this.closed) return Promise.reject(new Error("应用正在退出"));
    return new Promise((resolve, reject) => {
      if (!this.pending) this.pending = { sources: sources == null ? null : new Set(sources), forcePricing, immediate: !background, waiters: [] };
      else {
        if (sources == null) this.pending.sources = null;
        else if (this.pending.sources) for (const source of sources) this.pending.sources.add(source);
        this.pending.forcePricing ||= forcePricing;
        this.pending.immediate ||= !background;
      }
      this.pending.waiters.push({ resolve, reject });
      this.schedule();
    });
  }

  schedule() {
    if (this.running || !this.pending || this.closed) return;
    if (this.timer != null) this.clearTimer(this.timer);
    const wait = this.pending.immediate ? 0 : Math.max(0, this.lastStartedAt + this.interval() - this.now());
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
  }

  async flush() {
    const batch = this.pending;
    this.pending = null;
    this.running = true;
    this.lastStartedAt = this.now();
    try {
      const value = await this.run({ sources: batch.sources == null ? null : [...batch.sources], forcePricing: batch.forcePricing });
      for (const waiter of batch.waiters) waiter.resolve(value);
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  dispose() {
    this.closed = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    for (const waiter of this.pending?.waiters || []) waiter.reject(new Error("应用正在退出"));
    this.pending = null;
  }
}

module.exports = { RefreshScheduler };
