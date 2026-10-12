// Real Chromium/Worker regression using only the npm run preview synthetic dataset.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
app.setPath("userData", path.join(root, "out/receipt-ui-profile"));
if (process.argv.includes("--software")) app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1100, show: false,
    transparent: true, frame: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  if (process.argv.includes("--file")) {
    await win.loadFile(path.join(root, "src/renderer/index.html"), { query: { preview: "1", tab: "overview" } });
  } else await win.loadURL("http://127.0.0.1:4173/?preview=1&tab=overview");
  const checks = await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const waitFor = async (condition) => {
      const deadline = performance.now() + 15000;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error('Receipt UI timed out: ' + $('receiptStatus').textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const originalGetReceipt = window.widget.getReceipt;
    const workers = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url) { super(url); workers.push(this); }
      postMessage(...args) { this.started = true; super.postMessage(...args); }
      terminate() { this.stopped = true; super.terminate(); }
    };
    const results = {};
    // Saving must use the worker's original PNG, never re-encode a UI canvas.
    $('receiptCanvas').toBlob = () => { throw new Error('PNG encoding ran on the UI thread'); };
    results.iconsLoad = (await Promise.all(Object.values(window.ReceiptBrandIcons).map(src => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0); img.onerror = () => resolve(false); img.src = src;
    })))).every(Boolean);
    document.querySelector('[data-tab="receipt"]').click();
    $('receiptSource').value = 'devin'; $('receiptSource').dispatchEvent(new Event('change'));
    await waitFor(() => !$('receiptSave').disabled);
    results.devin = $('receiptText').textContent.includes('DEVIN') && $('receiptText').textContent.includes('SWE 2');
    const sample = await originalGetReceipt({ date: $('receiptDate').value, source: 'devin' });
    const longRows = Array.from({ length: 120 }, (_, i) => ({ ...sample.rows[0], model: 'swe-2-' + i, label: 'SWE 2 synthetic ' + i }));
    let ticks = 0, maxGap = 0, lastTick = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks++; }, 10);
    window.widget.getReceipt = async payload => ({ ...sample, ...payload, rows: longRows });
    const completeStart = performance.now();
    $('receiptRefresh').click();
    await waitFor(() => !$('receiptSave').disabled);
    await new Promise(resolve => setTimeout(resolve, 100));
    results.completeRenderResponsive = maxGap < 250;
    results.boundedPreview = $('receiptCanvas').width <= 780 && $('receiptCanvas').height <= 8192
      && $('receiptCanvas').width * $('receiptCanvas').height <= 4000000;
    let longExport;
    window.widget.saveReceipt = async payload => { longExport = payload; return { canceled: true }; };
    $('receiptSave').click(); await waitFor(() => !$('receiptSave').disabled);
    results.longPngExport = !!longExport?.image;
    const completeMs = Math.round(performance.now() - completeStart);
    $('receiptRefresh').click();
    await waitFor(() => workers.at(-1)?.started && !workers.at(-1).stopped);
    const oldWorker = workers.at(-1);
    await new Promise(resolve => setTimeout(resolve, 80));
    const ticksBeforeChange = ticks;
    results.interruptedBeforeCompletion = !oldWorker.stopped;
    results.controlsEnabled = ['receiptDate','receiptPeriod','receiptSource','receiptSort','receiptEffort','receiptSpeed','receiptRefresh'].every(id => !$(id).disabled);
    window.widget.getReceipt = originalGetReceipt;
    for (const [id, value] of [['receiptPeriod','year'], ['receiptSource','all'], ['receiptSort','model'], ['receiptSource','devin']]) {
      $(id).value = value; $(id).dispatchEvent(new Event('change'));
    }
    $('receiptEffort').checked = true; $('receiptEffort').dispatchEvent(new Event('change'));
    $('receiptSpeed').checked = false; $('receiptSpeed').dispatchEvent(new Event('change'));
    await waitFor(() => !$('receiptSave').disabled);
    clearInterval(timer);
    results.workerCanceled = oldWorker.stopped;
    results.responsive = ticksBeforeChange >= 3 && maxGap < 250;
    results.latestOnly = $('receiptText').textContent.includes('年度 AI 对账单')
      && $('receiptText').textContent.includes('DEVIN') && !$('receiptText').textContent.includes('CODEX')
      && !$('receiptText').textContent.includes('synthetic') && !$('receiptText').textContent.includes('non-fast');
    // A slow earlier data response must not even start a drawing worker.
    let resolveOld;
    window.widget.getReceipt = () => new Promise(resolve => { resolveOld = resolve; });
    $('receiptRefresh').click();
    window.widget.getReceipt = originalGetReceipt;
    $('receiptSource').value = 'codex'; $('receiptSource').dispatchEvent(new Event('change'));
    await waitFor(() => !$('receiptSave').disabled);
    const workerCount = workers.length, latestText = $('receiptText').textContent;
    resolveOld(sample);
    await new Promise(resolve => setTimeout(resolve, 50));
    results.staleDataIgnored = workers.length === workerCount && $('receiptText').textContent === latestText;
    // Export a final synthetic Devin receipt for visual inspection and exercise async PNG encoding.
    $('receiptSource').value = 'devin'; $('receiptSource').dispatchEvent(new Event('change'));
    await waitFor(() => !$('receiptSave').disabled);
    let saved;
    window.widget.saveReceipt = async payload => { saved = payload; return { canceled: true }; };
    $('receiptSave').click();
    await waitFor(() => !$('receiptSave').disabled);
    results.pngExport = saved?.period === 'year' && saved.image.startsWith('data:image/png;base64,');
    return { results, ticks, completeMs, maxGap: Math.round(maxGap), image: saved.image, longImage: longExport.image };
  })()`);
  const output = path.join(root, "out/receipt-ui"); fs.mkdirSync(output, { recursive: true });
  const longPng = Buffer.from(checks.longImage.split(",")[1], "base64");
  assert.equal(longPng.readUInt32BE(16), 1390, "export must retain the full receipt width");
  assert.ok(longPng.readUInt32BE(20) > 8192, "long receipt export must retain every row");
  fs.writeFileSync(path.join(output, "devin.png"), Buffer.from(checks.image.split(",")[1], "base64"));
  console.log(JSON.stringify({ checks: checks.results, ticks: checks.ticks, completeMs: checks.completeMs, maxGap: checks.maxGap, gpu: app.isHardwareAccelerationEnabled(), errors }, null, 2));
  for (const [key, value] of Object.entries(checks.results)) assert.equal(value, true, key);
  assert.deepEqual(errors, []);
  win.destroy(); setImmediate(() => app.exit(0));
}).catch(error => { console.error(error.message); app.exit(1); });
