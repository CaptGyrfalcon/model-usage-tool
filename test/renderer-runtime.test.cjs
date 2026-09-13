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
  assert.match(render([weekly], "absent"), /本周可用<\/span><b>2(?:\.0)?%/);
  assert.match(render([weekly], "unknown"), /当前可用<\/span><b>待确认/);
  assert.match(render([short, { ...weekly, usedPercent: 100 }], "present"), /5h 可用<\/span><b>0\.00%/);
});

test("adding a cycle reference leaves the chart's actual curve and horizontal labels unchanged", () => {
  const app = runtime();
  const result = app.run(`const series = [{at:200,remainingPercent:70},{at:400,remainingPercent:50}];
    const plain = levelChartSvg(series);
    const reference = levelChartSvg(series,{reference:{startAt:0,endAt:1000}});
    ({plain,reference});`);
  const actual = (svg) => svg.match(/class="level-line" points="([^"]+)"/)[1];
  const labels = (svg) => [...svg.matchAll(/<text class="axis-x"[^>]*>[^<]*<\/text>/g)].map((match) => match[0]);
  assert.equal(actual(result.plain), actual(result.reference));
  assert.deepEqual(labels(result.plain), labels(result.reference));
  assert.match(result.reference, /class="uniform-line" points="42.0,47.6 388.0,81.2"/);
});
