(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TrendRange = api;
})(typeof window === "object" ? window : globalThis, function () {
  const units = {
    hour: { label: "小时", bucket: "minute", bucketLabel: "分钟" },
    day: { label: "天", bucket: "hour", bucketLabel: "小时" },
    week: { label: "星期", bucket: "day", bucketLabel: "天" },
    month: { label: "月", bucket: "week", bucketLabel: "星期" },
    year: { label: "年", bucket: "month", bucketLabel: "月" },
  };

  function normalize(value = {}) {
    const count = Number(value.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("N 请输入 1–100 的整数");
    if (!Object.hasOwn(units, value.unit)) throw new Error("请选择小时、天、星期、月或年");
    return { count, unit: value.unit };
  }

  function shiftMonths(timestamp, months) {
    const date = new Date(timestamp);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return date.getTime();
  }

  function floor(timestamp, unit) {
    const date = new Date(timestamp);
    if (unit === "minute") return timestamp - date.getSeconds() * 1000 - date.getMilliseconds();
    if (unit === "hour") return timestamp - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
    date.setSeconds(0, 0);
    if (unit !== "minute") date.setMinutes(0);
    if (["day", "week", "month"].includes(unit)) date.setHours(0);
    if (unit === "week") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
    if (unit === "month") date.setDate(1);
    return date.getTime();
  }

  function advance(timestamp, unit) {
    if (unit === "minute") return timestamp + 60_000;
    if (unit === "hour") return timestamp + 3_600_000;
    const date = new Date(timestamp);
    if (unit === "month") date.setMonth(date.getMonth() + 1);
    else date.setDate(date.getDate() + (unit === "week" ? 7 : 1));
    return date.getTime();
  }

  function spec(value, now = Date.now()) {
    const { count, unit } = normalize(value);
    const definition = units[unit];
    let start;
    if (unit === "hour") start = now - count * 3_600_000;
    else if (unit === "month" || unit === "year") start = shiftMonths(now, -count * (unit === "year" ? 12 : 1));
    else {
      const date = new Date(now);
      date.setDate(date.getDate() - count * (unit === "week" ? 7 : 1));
      start = date.getTime();
    }
    // Clip calendar buckets to the rolling range; include events stamped exactly now.
    const end = now + 1;
    const boundaries = [start];
    for (let next = advance(floor(start, definition.bucket), definition.bucket); next < end; next = advance(next, definition.bucket)) {
      boundaries.push(next);
    }
    boundaries.push(end);
    return { count, unit, start, end, boundaries, ...definition,
      label: `近 ${count} ${definition.label} · 按${definition.bucketLabel}聚合` };
  }

  function labels(start, end, bucket) {
    const date = new Date(start);
    const pad = (number) => String(number).padStart(2, "0");
    const full = (timestamp) => {
      const d = new Date(timestamp);
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const shortLabel = bucket === "minute" ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
      : bucket === "hour" ? `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:00`
      : bucket === "month" ? `${date.getFullYear()}/${date.getMonth() + 1}`
      : `${date.getMonth() + 1}/${date.getDate()}`;
    return { label: `${full(start)}–${full(end - 1)}`, shortLabel };
  }
  return { units, normalize, spec, labels };
});
