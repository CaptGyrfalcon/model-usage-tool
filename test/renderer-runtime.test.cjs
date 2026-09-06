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
  const element = () => ({ addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
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
      UsageCharts: require("../src/renderer/usage-charts.js"), WidgetMotion: require("../src/renderer/motion.js"), LiquidPool: require("../src/renderer/liquid-pool.js") },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/renderer/app.js"), "utf8"), context);
  return { context, callbacks, frames, document, queries, run: (code) => vm.runInContext(code, context) };
}

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
