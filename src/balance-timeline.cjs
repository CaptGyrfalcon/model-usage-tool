const ReceiptModel = require("./renderer/receipt-model.js");
function localDate(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function buildBalanceTimeline(samples, { currency = "CNY", range = "day", cycleKey, now = Date.now() } = {}) {
  samples = samples.filter((sample) => sample.currency === currency && Number.isFinite(sample.at) && Number.isFinite(sample.balance))
    .sort((a, b) => a.at - b.at);
  const period = ["day", "week", "month", "year"].includes(range) ? range : "day";
  const groups = new Map();
  for (const at of [now, ...samples.map((sample) => sample.at)]) {
    const bounds = ReceiptModel.range(localDate(at), period);
    const key = localDate(bounds.start);
    groups.set(key, { key, startAt: bounds.start, endAt: bounds.end,
      label: `${localDate(bounds.start)} – ${localDate(bounds.end - 1)}` });
  }
  const cycles = [...groups.values()].sort((a, b) => b.startAt - a.startAt);
  const cycle = cycles.find((entry) => entry.key === cycleKey) || cycles[0];
  const actual = samples.filter((sample) => sample.at >= cycle.startAt && sample.at < cycle.endAt);
  // Keep every observation in SQLite. Limit drawing density while retaining
  // each time bucket's endpoints and extrema (including top-ups).
  let series = actual;
  if (actual.length > 1200) {
    const buckets = new Map();
    const span = Math.max(1, actual.at(-1).at - actual[0].at);
    for (const sample of actual) {
      const key = Math.min(299, Math.floor((sample.at - actual[0].at) / span * 300));
      const bucket = buckets.get(key) || { first: sample, last: sample, min: sample, max: sample };
      bucket.last = sample;
      if (sample.balance < bucket.min.balance) bucket.min = sample;
      if (sample.balance > bucket.max.balance) bucket.max = sample;
      buckets.set(key, bucket);
    }
    series = [...new Map([...buckets.values()].flatMap((bucket) => [bucket.first, bucket.min, bucket.max, bucket.last])
      .map((sample) => [sample.at, sample])).values()].sort((a, b) => a.at - b.at);
  }
  cycle.startRemaining = series[0]?.balance ?? null;
  cycle.endRemaining = series.at(-1)?.balance ?? null;
  return { kind: "balance", currency, range: period, cycles, cycle, series, sampleCount: actual.length,
    reconstructedCount: actual.filter((sample) => sample.origin === "platform-ledger-daily").length,
    change: series.length > 1 ? series.at(-1).balance - series[0].balance : null };
}
module.exports = { buildBalanceTimeline, localDate };
