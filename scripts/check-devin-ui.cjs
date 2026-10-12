// Isolated, offscreen Electron regression check with synthetic data only.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
app.setPath("userData", path.join(root, "out/devin-ui-profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 620, height: 960, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(root, "src/renderer/index.html"), { query: { preview: "1", tab: "overview" } });
  await new Promise(resolve => setTimeout(resolve, 500));
  const output = path.join(root, "out/devin-ui"); fs.mkdirSync(output, { recursive: true });
  const checks = await win.webContents.executeJavaScript(`(async () => {
    const results = {};
    settings.orbMode=false;settings.compact=false;settings.modelView='list';render();
    const d = snapshot.data;
    if (!d) throw new Error('Synthetic snapshot did not load');
    results.card = document.getElementById('devinPool').innerText.includes('SWE-2');
    results.glance = document.querySelectorAll('[data-quota-target="devinPool"]').length === 2;
    results.sources = document.querySelectorAll('[data-source="devin"]').length === 2
      && !!document.querySelector('[data-event-source="devin"]') && !!document.querySelector('[data-pricing-source="devin"]');
    results.noOverflow = document.body.scrollWidth <= innerWidth;
    results.unknownDollar = usagePools(d).filter(p => p.source === 'devin').every(p => !p.capacityCents);
    settings.dataSource='devin';settings.activeTab='models';render();
    results.models = document.getElementById('modelList').textContent.includes('SWE');
    settings.modelView='donut';render();
    results.donut = document.getElementById('modelDonutContent').innerText.includes('SWE');
    settings.activeTab='trends';render();
    results.trends = document.getElementById('trendChart').querySelectorAll('svg').length > 0;
    settings.activeTab='events';settings.eventSource='devin';await loadEventPage();render();
    results.events = document.getElementById('eventList').textContent.includes('Devin');
    settings.activeTab='pricing';settings.pricingSource='devin';await loadPricingCatalog();render();
    results.prices = document.getElementById('pricingList').innerText.includes('SWE');
    results.priceNote = document.getElementById('pricingNote').innerText.includes('原价');
    settings.activeTab='levels';settings.quotaLevelPool='devin-1440';await loadQuotaTimeline();render();
    results.dailyLevel = quotaTimeline.pool === 'devin-1440' && quotaTimeline.cycle.reference.estimated
      && quotaTimeline.cycle.endAt - quotaTimeline.cycle.startAt === 86400000;
    settings.quotaLevelPool='devin-10080';await loadQuotaTimeline();render();
    results.weeklyLevel = quotaTimeline.pool === 'devin-10080'
      && quotaTimeline.cycle.endAt - quotaTimeline.cycle.startAt === 7 * 86400000;
    settings.activeTab='overview';settings.compact=true;render();
    results.compact = document.body.classList.contains('compact') && document.body.scrollWidth <= innerWidth;
    settings.compact=false;await window.widget.toggleFullscreen(true);render();
    results.fullscreen = document.body.classList.contains('fullscreen') && document.body.scrollWidth <= innerWidth;
    await window.widget.toggleFullscreen(false);
    settings.orbMode=true;settings.orbDisplayMode='quota';settings.orbPool='devin-window-1440';render();
    results.orb = document.getElementById('orbPoolName').innerText.includes('Devin');
    settings.orbDisplayMode='pool';settings.orbPoolCombined=false;render();
    results.pools = document.querySelectorAll('[data-usage-pool^="devin-"]').length === 2;
    document.getElementById('receiptSource').value='devin';
    document.getElementById('receiptSource').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    results.receipt = document.getElementById('receiptCanvas').width > 0 && !document.getElementById('receiptSave').disabled;
    settings.orbMode=false;settings.activeTab='overview';settings.modelView='list';render();
    document.getElementById('devinPool').scrollIntoView({block:'center'});
    return results;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(output, "overview.png"), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ checks, errors }, null, 2));
  for (const [key, value] of Object.entries(checks)) assert.equal(value, true, key);
  assert.deepEqual(errors, []);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
