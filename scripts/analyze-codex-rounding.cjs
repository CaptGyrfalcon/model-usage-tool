// Read-only audit: each reset/plan/window has its own independent capacity.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const databaseIndex = process.argv.indexOf('--database');
const db = new DatabaseSync(databaseIndex >= 0 ? process.argv[databaseIndex + 1]
  : path.join(process.env.APPDATA, 'cursor-usage-widget/usage-history.sqlite'), { readOnly: true });
const recovered = db.prepare("SELECT 1 FROM app_cache WHERE key='codex-provenance-samples-v1'").get();
const samples = db.prepare(`SELECT timestamp, used_percent p, window_minutes minutes,
  resets_at reset, plan_type plan FROM ${recovered ? "codex_quota_observations WHERE quality='valid'" : "quota_samples WHERE source='codex'"}
  AND plan_type IS NOT NULL AND resets_at IS NOT NULL AND used_percent IS NOT NULL
  ORDER BY timestamp`).all();
const events = db.prepare(`SELECT timestamp, model, quota_equivalent_cost_cents cost
  FROM usage_events WHERE source='codex' AND lower(model) NOT LIKE '%spark%' ORDER BY timestamp`).all();
const groups = [];
for (const s of samples) {
  let g = groups.find(g => g.plan === s.plan && g.minutes === s.minutes && Math.abs(g.reset - s.reset) <= 60000);
  if (!g) { g = { plan: s.plan, minutes: s.minutes, reset: s.reset, samples: [] }; groups.push(g); }
  g.samples.push(s);
}
function constraints(points, mode, error = 0) {
  let lo = 0, hi = Infinity, loAt = null, hiAt = null;
  for (const { p, cost, timestamp } of points) {
    const a = Math.max(0, p - (mode === 'floor' ? 0 : mode === 'nearest' ? .5 : 1) - error);
    const b = p === 100 ? Infinity : p + (mode === 'ceil' ? 0 : mode === 'nearest' ? .5 : 1) + error;
    const lower = b > 0 ? 100 * cost / b : cost > 0 ? Infinity : 0;
    const upper = a > 0 ? 100 * cost / a : Infinity;
    if (lower > lo) { lo = lower; loAt = timestamp; }
    if (upper < hi) { hi = upper; hiAt = timestamp; }
  }
  return { valid: Number.isFinite(lo) && hi > 0 && lo <= hi, lo, hi, loAt, hiAt };
}
function assess(points, mode) {
  const strict = constraints(points, mode);
  let a = 0, b = 100;
  if (!strict.valid) for (let i = 0; i < 35; i++) { const m = (a+b)/2; if (constraints(points, mode, m).valid) b=m; else a=m; }
  return { ...strict, minimumExtraPercentagePoints: strict.valid ? 0 : b };
}
const reports = groups.map(g => {
  const start = g.reset - g.minutes * 60000;
  const rows = g.samples.filter(s => s.timestamp >= start && s.timestamp < g.reset);
  const last = rows.at(-1)?.timestamp ?? 0;
  const usage = events.filter(e => e.timestamp >= start && e.timestamp <= last);
  const unknown = usage.filter(e => e.cost == null && e.model !== 'codex-auto-review');
  function pointsAt(lag) {
    let cost=0, i=0;
    return rows.map(s => { while(i<usage.length && usage[i].timestamp <= s.timestamp-lag) cost += usage[i++].cost || 0;
      return { ...s, cost }; });
  }
  const points=pointsAt(0);
  return { plan:g.plan, minutes:g.minutes, reset:g.reset, start, first:rows[0]?.timestamp, last,
    n:rows.length, min:Math.min(...rows.map(s=>s.p)), max:Math.max(...rows.map(s=>s.p)),
    unknown:unknown.length,
    usableForComparison: unknown.length === 0 && rows.length >= 10 && new Set(rows.map(s=>s.p)).size > 1,
    // Results with missing prices are diagnostic only, never evidence for a mode.
    models:[...new Set(usage.map(e=>e.model))], events:usage.length,
    decreases:rows.filter((s,i)=>i && s.p < rows[i-1].p).length,
    modes:Object.fromEntries(['floor','nearest','ceil','unknown'].map(m=>[m, assess(points,m)])),
    lagSensitivity:Object.fromEntries([1000,5000,15000,30000].map(lag=>[lag,Object.fromEntries(['floor','nearest','ceil'].map(m=>[m,assess(pointsAt(lag),m)]))])),
    points,
  };
});
db.close();
if (process.argv.includes('--full')) console.log(JSON.stringify(reports));
else console.log(JSON.stringify(reports.map(({points,lagSensitivity,...r})=>r),null,2));
