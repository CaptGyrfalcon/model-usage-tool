const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function runtime() {
  const elements = new Map();
  const callbacks = {};
  const frames = new Map();
  const queries = [];
  let frameId = 0;
  const element = () => ({ listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, querySelectorAll: () => [], querySelector: () => null,
    classList: { toggle() {}, contains: () => true, add() {}, remove() {} },
    style: { setProperty() {} }, setAttribute() {}, getClientRects: () => [],
  });
  const document = { hidden: false, body: element(), documentElement: element(),
    querySelectorAll: () => [], getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    addEventListener(name, callback) { callbacks[name] = callback; },
  };
  const pending = () => new Promise(() => {});
  const widget = { getSettings: pending, getSnapshot: pending, getWindowState: pending,
    onSnapshot(callback) { callbacks.snapshot = callback; }, onSettings() {}, onWindowState() {}, onWindowMotion() {},
    queryUsageEvents() { queries.push("events"); return pending(); },
  };
  const context = vm.createContext({ document, console, setTimeout, clearTimeout, setInterval() {},
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { observe() {} },
    window: { widget, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
      TrendRange: require("../src/renderer/trend-range.js"),
      ModelDisplay: require("../src/renderer/model-display.js"),
      UsageCharts: require("../src/renderer/usage-charts.js"), WidgetMotion: require("../src/renderer/motion.js"), FullscreenMorph: require("../src/renderer/fullscreen-morph.js"), LiquidPool: require("../src/renderer/liquid-pool.js") },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/renderer/app.js"), "utf8"), context);
  return { context, callbacks, frames, document, queries, run: (code) => vm.runInContext(code, context) };
}

test("model trend mode renders matching bars, legend and tooltip and persists exclusive selection", () => {
  const app = runtime();
  const saved = [];
  app.context.window.widget.saveSettings = (partial) => saved.push(partial);
  app.run('settings.trendBreakdown = true; settings.trendSpeedBreakdown = true;');
  app.document.getElementById("modelBreakdownBtn").listeners.click();
  assert.equal(saved.at(-1).trendModelBreakdown, true);
  assert.equal(saved.at(-1).trendBreakdown, false);
  assert.equal(saved.at(-1).trendSpeedBreakdown, false);
  app.run(`renderTrends({ sources: { all: { costAvailable: true, trends: { day: [
    { total: 40, count: 2, shortLabel: '12', models: { 'gpt-5.6-sol': {total: 30}, 'grok-4.6': {total: 10} } }
  ] } } } }); fillChartTooltip(0);`);
  assert.match(app.document.getElementById("trendChart").innerHTML, /chart-segment model/);
  assert.match(app.document.getElementById("legendItems").innerHTML, /GPT 5.6 Sol/);
  const tooltip = app.document.getElementById("chartTooltipRows").innerHTML;
  assert.match(tooltip, /75%/);
  assert.match(tooltip, /25%/);
  assert.doesNotMatch(tooltip, /Fast/);
  app.document.getElementById("speedBreakdownBtn").listeners.click();
  assert.equal(saved.at(-1).trendModelBreakdown, false);
  assert.equal(saved.at(-1).trendSpeedBreakdown, true);
});

test("custom trend requests ignore stale responses and allow retry after errors", async () => {
  const app = runtime();
  const pending = [];
  app.context.window.widget.getTrendUsage = (payload) => new Promise((resolve, reject) => pending.push({payload, resolve, reject}));
  app.run('settings.trendCustomCount=1; settings.trendCustomUnit="hour";');
  const first = app.run('loadCustomTrends()');
  app.run('settings.trendCustomCount=2;');
  const second = app.run('loadCustomTrends()');
  pending[1].resolve({ marker: "new" });
  await second;
  pending[0].resolve({ marker: "old" });
  await first;
  assert.equal(app.run('customTrendUsage.marker'), "new");
  const failed = app.run('loadCustomTrends()');
  pending[2].reject(new Error("读取失败"));
  await failed;
  assert.equal(app.run('customTrendLoading'), false);
  assert.equal(app.run('customTrendError'), "读取失败");
  const retry = app.run('loadCustomTrends()');
  pending[3].resolve({ marker: "retried" });
  await retry;
  assert.equal(app.run('customTrendUsage.marker'), "retried");
  assert.equal(app.run('customTrendError'), "");
});

test("custom trend refresh preserves pixel scroll through loading, failure and retry", async () => {
  const app = runtime();
  const chart = app.document.getElementById("trendChart");
  let html = "", left = 0, maxLeft = 0;
  Object.defineProperties(chart, {
    innerHTML: { get: () => html, set(value) {
      html = value;
      maxLeft = Math.max(0, Number(value.match(/<svg[^>]* width="(\d+)"/)?.[1] || 400) - 400);
      left = Math.min(left, maxLeft);
    } },
    scrollLeft: { get: () => left, set(value) { left = Math.max(0, Math.min(value, maxLeft)); } },
  });
  chart.querySelector = () => html.includes('class="bar-chart') ? { classList: { remove() {} } } : null;
  const data = (length) => ({ range: { label: "近 10 天" }, sources: { all: {
    trends: { custom: Array.from({ length }, (_, i) => ({ total: i, shortLabel: String(i) })) },
  } } });
  const pending = [];
  app.context.window.widget.getTrendUsage = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  app.run('settings.trendRange="custom"; settings.trendCustomCount=10; snapshot.data={};');
  const initial = app.run('loadCustomTrends()');
  pending.shift().resolve(data(240));
  await initial;
  chart.scrollLeft = 713.5;
  for (const outcome of [data(300), new Error("offline"), data(240)]) {
    // Snapshot refresh invalidates the query before the scheduled render.
    app.run('customTrendKey=null; renderTrends(snapshot.data); renderTrends(snapshot.data);');
    assert.equal(chart.scrollLeft, 0); // Placeholder cannot physically scroll.
    const request = pending.shift();
    if (outcome instanceof Error) request.reject(outcome);
    else request.resolve(outcome);
    await new Promise(setImmediate);
    assert.equal(chart.scrollLeft, outcome instanceof Error ? 0 : 713.5);
  }
  chart.scrollLeft = 500;
  app.run('renderTrends(snapshot.data);');
  assert.equal(chart.scrollLeft, 500);
  app.run('settings.trendCustomCount=20; renderTrends(snapshot.data);');
  pending.shift().resolve(data(480));
  await new Promise(setImmediate);
  assert.equal(chart.scrollLeft, 0);
});

test("custom trend form saves its range and rejects invalid N without querying", async () => {
  const app = runtime();
  const saved = [];
  const queries = [];
  app.context.window.widget.saveSettings = (value) => saved.push(value);
  app.context.window.widget.getTrendUsage = async (payload) => { queries.push(payload); return {}; };
  const submit = app.document.getElementById("trendCustomForm").listeners.submit;
  app.document.getElementById("trendCustomCount").value = "0";
  app.document.getElementById("trendCustomUnit").value = "year";
  submit({preventDefault() {}});
  assert.equal(queries.length, 0);
  assert.match(app.document.getElementById("trendCustomHint").textContent, /1–100/);
  app.document.getElementById("trendCustomCount").value = "3";
  submit({preventDefault() {}});
  assert.equal(saved[0].trendRange, "custom");
  assert.equal(saved[0].trendCustomCount, 3);
  assert.equal(queries[0].unit, "year");
  await Promise.resolve();
});

test("titlebar double-click toggles fullscreen both ways but ignores window controls", () => {
  const app = runtime();
  app.run('setFullscreen = () => { windowState.fullscreen = !windowState.fullscreen; };');
  const doubleClick = app.document.getElementById("titlebar").listeners.dblclick;
  const event = { button: 0, target: { closest: () => null }, preventDefault() {} };
  doubleClick(event);
  assert.equal(app.run("windowState.fullscreen"), true);
  doubleClick(event);
  assert.equal(app.run("windowState.fullscreen"), false);
  doubleClick({ ...event, target: { closest: () => ({}) } });
  assert.equal(app.run("windowState.fullscreen"), false);
  doubleClick({ ...event, button: 2 });
  assert.equal(app.run("windowState.fullscreen"), false);
});

test("titlebar dragging uses pointer capture and is disabled in fullscreen", () => {
  const app = runtime();
  const phases = [];
  app.context.window.widget.titlebarDrag = (phase) => phases.push(phase);
  const titlebar = app.document.getElementById("titlebar");
  let captured = null;
  titlebar.setPointerCapture = (id) => { captured = id; };
  titlebar.hasPointerCapture = (id) => captured === id;
  titlebar.releasePointerCapture = () => { captured = null; };
  const event = { button: 0, pointerId: 1, target: { closest: () => null } };
  titlebar.listeners.pointerdown(event);
  titlebar.listeners.pointermove(event);
  titlebar.listeners.pointerup(event);
  titlebar.listeners.pointermove(event);
  assert.deepEqual(phases, ["start", "move", "end"]);
  assert.equal(captured, null);
  app.run("windowState.fullscreen = true;");
  titlebar.listeners.pointerdown(event);
  titlebar.listeners.pointermove(event);
  assert.deepEqual(phases, ["start", "move", "end"]);
  app.run("windowState.fullscreen = false;");
  titlebar.listeners.pointerdown({ ...event, target: { closest: () => ({}) } });
  assert.deepEqual(phases, ["start", "move", "end"]);
});

test("renderer cancels its scheduled liquid frame when the window is hidden", () => {
  const app = runtime();
  app.run('settings.orbMode = true; settings.orbDisplayMode = "pool"; ensureLiquidAnimation([{id:"test",remaining:40}]);');
  assert.equal(app.frames.size, 1);
  app.document.hidden = true;
  app.callbacks.visibilitychange();
  assert.equal(app.frames.size, 0);
  app.run('ensureLiquidAnimation([{id:"test",remaining:20}]);');
  assert.equal(app.frames.size, 0);
});

test("renderer reduced motion immediately shows exact levels with no animation frame", () => {
  const app = runtime();
  app.run('settings.motionPreference="reduce"; ensureLiquidAnimation([{id:"test",remaining:40,weeklyRemaining:0}]);');
  assert.equal(app.frames.size, 0);
  assert.equal(app.run('liquidState.levels.get("test").level'), 40);
  assert.equal(app.run('liquidState.levels.get("test").weeklyLevel'), 0);
});

test("loading notifications update status without rerendering or querying event history", () => {
  const app = runtime();
  app.run('settings.activeTab="events";');
  app.callbacks.snapshot({ loading: true, data: { fetchedAt: Date.now() } });
  assert.equal(app.queries.length, 0);
  assert.equal(app.frames.size, 0);
});

test("unknown quotas are omitted rather than displayed as a full remaining pool", () => {
  const app = runtime();
  assert.equal(app.run('quotaPools({cursorModels:{percentUsed:null},codex:{quota:{windows:[{usedPercent:null,percentRemaining:null}]}}}).length'), 0);
  assert.equal(app.run('quotaPools({cursorModels:{percentUsed:70,percentRemaining:null}})[0].remaining'), 30);
});

test("mini mode renders the overview while preserving the full window's selected tab", () => {
  const app = runtime();
  const result = app.run(`settings.compact = true; settings.activeTab = "models";
    let renderedView;
    renderOverview = () => { renderedView = "overview"; };
    renderModels = () => { renderedView = "models"; };
    renderActiveView({});
    ({ renderedView, selected: settings.activeTab });`);
  assert.equal(result.renderedView, "overview");
  assert.equal(result.selected, "models");
});

function overviewFixture(costAvailable = true) {
  const now = Date.now();
  return {
    planName: "Pro", billingCycleEnd: now + 86_400_000,
    tokens: { today: { total: 1_000 } },
    cursorModels: { percentUsed: 60, percentRemaining: 40, hint: "Grok", quotaEstimate: { usedCents: 100, inferredTotalCents: 250 }, apiEquivalent: {}, tokens: {} },
    otherModels: null,
    devin: { planName: "Pro", tokens: { today: {} }, subscription: {}, quota: { windows: [
      { name: "每日", windowMinutes: 1440, usedPercent: 10, percentRemaining: 90, expired: true },
      { name: "每周", windowMinutes: 10080, usedPercent: 20, percentRemaining: 80, resetsAt: now + 3_600_000 },
    ] } },
    combined: { tokens: { today: { total: 15 } } },
    sources: { all: { costAvailable, trends: { day: [
      { start: now - 7_200_000, end: now - 3_600_000, total: 10, equivalentCostCents: 125 },
      { start: now - 3_600_000, end: now + 1, total: 5, equivalentCostCents: 75 },
    ] } } },
  };
}

test("overview keeps unknown and expired quotas unknown and lists unconnected sources", () => {
  const app = runtime();
  app.run("renderVerification = () => {};");
  app.context.testData = overviewFixture();
  app.run("renderOverview(testData)");
  const html = app.document.getElementById("overviewRoot").innerHTML;
  assert.match(html, /id="cursorPool"/);
  assert.match(html, /id="devinPool"/);
  assert.match(html, /三方模型[\s\S]*?—[\s\S]*?暂不可用/);
  assert.match(html, /已重置 · 等待新采样/);
  // Only the two windows with a live percentage draw a ring value.
  assert.equal((html.match(/ov-ring-value/g) || []).length, 2);
  assert.match(html, /<b>—<\/b><small>今日 Token<\/small>/);
  assert.match(html, /未找到可读取的 Codex 本机会话/);
  assert.match(html, /未找到 DeepSeek Harness 数据/);
  assert.match(html, /今日美元等效<\/span>\s*<b>\$2\.00<\/b>/);
  app.context.testData = overviewFixture(false);
  app.run("renderOverview(testData)");
  assert.match(app.document.getElementById("overviewRoot").innerHTML, /今日美元等效<\/span>\s*<b>—<\/b>/);
});

test("overview card expansion survives the next refresh", () => {
  const app = runtime();
  app.run("renderVerification = () => {};");
  app.document.body.classList.contains = () => false;
  app.context.testData = overviewFixture();
  app.run("renderOverview(testData)");
  const attributes = {};
  const card = { classList: { toggle(name, on) { attributes[name] = on; } }, scrollIntoView() {} };
  const toggle = { dataset: { ovToggle: "devin" }, setAttribute(key, value) { attributes[key] = value; }, closest: () => card };
  const target = { closest: (selector) => (selector === "[data-ov-toggle]" ? toggle : null) };
  app.document.getElementById("overviewRoot").listeners.click({ target });
  assert.equal(attributes.open, true);
  assert.equal(attributes["aria-expanded"], "true");
  app.run("renderOverview(testData)");
  assert.match(app.document.getElementById("overviewRoot").innerHTML, /class="ov-source devin open"[\s\S]*?aria-expanded="true"/);
});

function modelFixture(costAvailable) {
  return `modelUsage = { key: settings.modelRange, sources: { all: { label: "全部", costAvailable: ${costAvailable}, eventCount: 3, modelBreakdowns: { coarse: [
    { name: "grok-4.6", total: 25, effective: 10, count: 1, input: 5, cacheWrite: 0, cacheRead: 15, output: 5, costCents: 0 },
    { name: "gpt-5.6-sol", total: 100, effective: 40, count: 2, input: 20, cacheWrite: 10, cacheRead: 50, output: 20, costCents: 1234 },
  ] } } } };`;
}

test("model list ranks by total, uses provider logos and scales composition bars to the leader", () => {
  const app = runtime();
  app.context.window.ReceiptModel = require("../src/renderer/receipt-model.js");
  app.context.window.ReceiptBrandIcons = { openai: "data:openai", xai: "data:xai" };
  app.run(`settings.modelRange = "month1"; settings.modelView = "list"; ${modelFixture(true)} renderModels({});`);
  const html = app.document.getElementById("modelList").innerHTML;
  assert.ok(html.indexOf("GPT 5.6 Sol") < html.indexOf("Grok 4.6"));
  assert.match(html, /md-logo openai[^>]*><img src="data:openai"/);
  assert.match(html, /\$12\.34/);
  const widths = [...html.matchAll(/<g class="md-bar-fill">(.*?)<\/g>/g)]
    .map(([, bar]) => [...bar.matchAll(/width="([\d.]+)"/g)].reduce((sum, [, w]) => sum + Number(w), 0));
  assert.deepEqual(widths.map((w) => Math.round(w)), [100, 25]);
  assert.match(html, /占 80\.0%/);
});

test("unpriced model usage says so instead of showing zero dollars", () => {
  const app = runtime();
  app.run(`settings.modelRange = "month1"; settings.modelView = "list"; ${modelFixture(false)} renderModels({});`);
  const html = app.document.getElementById("modelList").innerHTML;
  assert.match(html, /class="unpriced">未计价/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("model row expansion survives the next refresh", () => {
  const app = runtime();
  app.document.body.classList.contains = () => false;
  app.run(`settings.modelRange = "month1"; settings.modelView = "list"; ${modelFixture(true)} renderModels({});`);
  const list = app.document.getElementById("modelList");
  const key = list.innerHTML.match(/data-md-toggle="([^"]+)"/)[1].replace(/&quot;/g, '"');
  const row = { classList: { toggle() {} } };
  const toggle = { dataset: { mdToggle: key }, setAttribute() {}, closest: () => row };
  list.listeners.click({ target: { closest: (selector) => (selector === "[data-md-toggle]" ? toggle : null) } });
  app.run("renderModels({})");
  assert.match(list.innerHTML, /class="md-row open"[\s\S]*?aria-expanded="true"/);
});

test("renderer markup has unique IDs and every referenced ID exists", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../src/renderer/app.js"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const dynamic = new Set([...app.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
  for (const [, id] of app.matchAll(/\$\("([\w-]+)"\)/g)) assert.ok(ids.includes(id) || dynamic.has(id), id);
});

test("monthly pool shows the current window separately, capped by weekly availability", () => {
  const app = runtime();
  const { buildCodexMonthly } = require("../src/renderer/codex-monthly.js");
  const { codexPool } = require("../src/renderer/liquid-pool.js");
  const now = new Date(2026, 8, 16).getTime();
  const weekly = { windowMinutes: 10080, usedPercent: 98, resetsAt: now + 86400000,
    quotaEstimate: { inferredTotalCents: 10000 } };
  const short = { windowMinutes: 300, usedPercent: 20, quotaEstimate: { inferredTotalCents: 2000 } };
  const render = (windows, shortLimit) => {
    app.context.testPool = codexPool(windows, null, buildCodexMonthly({ windows, shortLimit, now }), shortLimit);
    return app.run('renderUsagePoolCard(testPool, "sphere")');
  };
  assert.match(render([short, weekly], "present"), /5h 可用<\/span><b>≈10\.00%/);
  assert.match(render([weekly], "absent"), /本周可用<\/span><b>2\.00%/);
  assert.match(render([weekly], "unknown"), /当前可用<\/span><b>待确认/);
  assert.match(render([short, { ...weekly, usedPercent: 100 }], "present"), /5h 可用<\/span><b>0\.00%/);
});

test("adding a cycle reference leaves the chart's actual curve and horizontal labels unchanged", () => {
  const app = runtime();
  const result = app.run(`const series = [{at:200,remainingPercent:70},{at:400,remainingPercent:50}];
    const plain = levelChartSvg(series);
    const reference = levelChartSvg(series,{reference:{startAt:0,endAt:1000}});
    ({plain,reference});`);
  const actual = (svg) => svg.match(/class="level-line"[^>]* points="([^"]+)"/)[1];
  const labels = (svg) => [...svg.matchAll(/<text class="axis-x"[^>]*>[^<]*<\/text>/g)].map((match) => match[0]);
  assert.equal(actual(result.plain), actual(result.reference));
  assert.deepEqual(labels(result.plain), labels(result.reference));
  assert.match(result.reference, /class="uniform-line" points="42.0,47.6 388.0,81.2"/);
});

test("DeepSeek water level renders currency, top-ups and negative balances without subscription percentages", () => {
  const app = runtime();
  app.run(`const start = Date.now() - 3600000;
    quotaTimeline = { kind: 'balance', pool: 'deepseek-balance-CNY', currency: 'CNY', change: 8,
      pools: [{id:'deepseek-balance-CNY',label:'DeepSeek CNY 余额',hasData:true}],
      cycle: {key:'today',label:'今日',startAt:start,endAt:Date.now()+1000,startRemaining:-2,endRemaining:6},
      cycles: [{key:'today',label:'今日'}],
      series: [{at:start+1000,balance:-2,toppedUp:-2,granted:0},{at:start+2000,balance:6,toppedUp:0,granted:6}] };
    renderLevels();`);
  assert.equal(app.document.getElementById("balanceRangeSwitch").hidden, false);
  assert.equal(app.document.getElementById("levelStart").textContent, "¥-2.00");
  assert.equal(app.document.getElementById("levelTotal").textContent, "¥6.00");
  assert.equal(app.document.getElementById("levelPaceLabel").textContent, "已采样净变化");
  assert.equal(app.document.getElementById("levelPace").textContent, "+¥8.00");
  assert.equal(app.document.getElementById("uniformLegend").hidden, true);
  const svg = app.document.getElementById("levelChart").innerHTML;
  assert.match(svg, /DeepSeek 余额变化趋势/);
  assert.doesNotMatch(svg, /NaN|uniform-line|\d+%/);
  assert.match(app.document.getElementById("uniformNote").textContent, /净变化 \+¥8.00/);
  app.document.getElementById("chartTooltip").getBoundingClientRect = () => ({ width: 150, height: 50 });
  app.context.window.innerWidth = 800;
  app.context.window.innerHeight = 600;
  app.run(`handleLevelPointerMove({target:{closest:()=>({dataset:{levelIndex:'1'}})},clientX:10,clientY:20});`);
  assert.equal(app.document.getElementById("chartTooltipTotal").textContent, "余额 ¥6.00");
  assert.match(app.document.getElementById("chartTooltipRows").innerHTML, /赠送余额 ¥6.00/);
});
test("DeepSeek request dollars retain sub-cent precision without implying an actual bill", () => {
  const app=runtime();
  assert.equal(app.run(`formatRequestUsd({source:'deepseek'},0.001)`),'$0.000010');
  assert.equal(app.run(`formatRequestUsd({source:'deepseek'},0.000001)`),'<$0.000001');
  assert.equal(app.run(`formatRequestUsd({source:'deepseek'},null)`),'—');
  assert.equal(app.run(`formatRequestUsd({source:'cursor'},0.001)`),'$0.00');
});

test("trend stats average only elapsed buckets and bars animate on selection change, not on refresh", () => {
  const app = runtime();
  const now = Date.now();
  app.context.testData = { sources: { all: { costAvailable: true, trends: { day: [
    { start: now - 7_200_000, total: 30, shortLabel: "01", label: "01:00–02:00" },
    { start: now - 3_600_000, total: 10, shortLabel: "02", label: "02:00–03:00" },
    { start: now + 3_600_000, total: 0, shortLabel: "04", label: "04:00–05:00" },
  ] } } } };
  app.run("settings.trendRange = 'day'; settings.trendMetric = 'total'; renderTrends(testData)");
  const text = (id) => app.document.getElementById(id).textContent;
  assert.equal(text("trendTotalLabel"), "总 Token合计");
  assert.equal(text("trendAvgLabel"), "平均 / 小时");
  assert.equal(text("trendAvg"), app.run("formatTokens(20)"));
  assert.equal(text("trendPeakLabel"), "峰值 · 01:00–02:00");
  assert.equal(text("chartPeak"), app.run("formatTokens(30)"));
  assert.match(app.document.getElementById("trendChart").innerHTML, /class="bar-chart animate"/);
  app.run("renderTrends(testData)");
  assert.doesNotMatch(app.document.getElementById("trendChart").innerHTML, /animate/);
  app.run("settings.trendMetric = 'effective'; renderTrends(testData)");
  assert.match(app.document.getElementById("trendChart").innerHTML, /class="bar-chart animate"/);
});

test("level pace uses the cycle reference at the latest real sample and stays unknown without one", () => {
  const app = runtime();
  app.context.window.ReceiptBrandIcons = { openai: "data:openai" };
  const timeline = (reference) => `quotaTimeline = { pool: 'codex-10080',
    pools: [{ id: 'codex-10080', label: 'Codex 每周', hasData: true }, { id: 'other-models', label: 'Cursor 三方模型池', hasData: false }],
    cycle: { key: 'c', label: '当前', startAt: 0, endAt: Date.now() + 1000, startRemaining: 90, endRemaining: 40${reference ? ", reference: { startAt: 0, endAt: 1000 }" : ""} },
    cycles: [{ key: 'c', label: '当前' }],
    series: [{ at: 100, remainingPercent: 90 }, { at: 400, remainingPercent: 40 }, { at: 900, remainingPercent: 10, projected: true }] };
    renderLevels();`;
  const pace = app.document.getElementById("levelPace");
  const classes = new Set();
  pace.classList = { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } };
  app.run(timeline(true));
  // 400 of a 0–1000 reference leaves 60%; the projected point at 900 is ignored.
  assert.equal(pace.textContent, app.run("formatCursorPct(60)"));
  assert.deepEqual([...classes], ["down"]);
  assert.equal(app.document.getElementById("levelStart").textContent, app.run("formatCursorPct(90)"));
  const chips = app.document.getElementById("levelPoolSwitch").innerHTML;
  assert.match(chips, /class="lv-pool active"[^>]*data-level-pool="codex-10080"[^>]*><span class="vw-logo"[^>]*><img src="data:openai"[^>]*><\/span>每周/);
  assert.match(chips, /data-level-pool="other-models"[^>]* disabled>[\s\S]*?三方模型池/);
  app.run(timeline(false));
  assert.equal(pace.textContent, "—");
  assert.deepEqual([...classes], []);
});

test("events group by local day, show clock time and a composition bar of the request's own tokens", () => {
  const app = runtime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
  const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 23, 30).getTime();
  app.context.testPage = { total: 3, offset: 0, limit: 40, events: [
    { source: "devin", model: "swe-2", timestamp: today, input: 25, cacheWrite: 0, cacheRead: 50, output: 25, equivalentCostCents: 110 },
    { source: "codex", model: "gpt-5.6-sol", timestamp: today - 60_000, input: 1, output: 1, equivalentCostCents: 1 },
    { source: "cursor", model: "grok-4.6", timestamp: earlier, input: 1, output: 1, equivalentCostCents: 1 },
  ] };
  app.run("eventPage = testPage; renderEvents()");
  const html = app.document.getElementById("eventList").innerHTML;
  assert.equal((html.match(/class="ev-day"/g) || []).length, 2);
  assert.match(html, /<div class="ev-day">今天 · /);
  assert.match(html, /<span>09:05<\/span><span>Devin<\/span>/);
  const bar = html.match(/<svg class="ev-bar"[^>]*>(.*?)<\/svg>/)[1];
  assert.deepEqual([...bar.matchAll(/width="([\d.]+)"/g)].map(([, w]) => Number(w)), [25, 0, 50, 25]);
  assert.equal(app.document.getElementById("eventPager").innerHTML, "");
});

test("pricing groups consecutive tiers per model and never shows unknown rates as $0", () => {
  const app = runtime();
  app.context.testCatalog = { selectedId: 1, snapshots: [], rows: [
    { source: "cursor", model: "grok-4.6", speed: "normal", speedLabel: "非 Fast", contextLabel: "全部上下文", input: 2, output: 6, cacheWrite: 0, cacheRead: 0.5 },
    { source: "cursor", model: "grok-4.6", speed: "fast", speedLabel: "Fast", contextLabel: "全部上下文", input: 4, output: 12, cacheWrite: null, cacheRead: 1 },
    { source: "codex", model: "gpt-5.6-sol", speed: "normal", speedLabel: "非 Fast", contextLabel: "默认上下文", input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 },
  ] };
  app.run("pricingCatalog = testCatalog; renderPricing()");
  const html = app.document.getElementById("pricingList").innerHTML;
  assert.equal((html.match(/class="pr-group"/g) || []).length, 2);
  assert.equal((html.match(/class="pr-tier pr-cols"/g) || []).length, 3);
  assert.match(html, /<b class="zero">\$0<\/b>/);
  assert.match(html, /<b class="">—<\/b>/);
  assert.equal(app.run("formatRate(null)"), "—");
});

test("balance range selection persists and requests calendar ranges without an old cycle selection", async () => {
  const app = runtime();
  const saved = [], requests = [];
  app.context.window.widget.saveSettings = (value) => saved.push(value);
  app.context.window.widget.getQuotaTimeline = (payload) => { requests.push(payload); return new Promise(() => {}); };
  app.run(`settings.quotaLevelPool='deepseek-balance-CNY'; selectedCycleKey='old-day';`);
  for (const range of ["day", "week", "month", "year"]) {
    app.document.getElementById("balanceRangeSwitch").listeners.click({ target: { closest: () => ({ dataset: { balanceRange: range } }) } });
    assert.equal(saved.at(-1).balanceRange, range);
    assert.equal(requests.at(-1).range, range);
    assert.equal(requests.at(-1).cycleKey, null);
    assert.equal(requests.at(-1).pool, "deepseek-balance-CNY");
  }
});
