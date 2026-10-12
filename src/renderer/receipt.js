(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("receiptCanvas");
  const dateInput = $("receiptDate");
  const status = $("receiptStatus");
  const save = $("receiptSave");
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  dateInput.value = localDate(new Date());
  let requestId = 0, ready = null, saving = false, rendering = null;
  const images = Promise.all(Object.entries(window.ReceiptBrandIcons || {}).map(([name, src]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      // Rasterize bundled SVGs at export resolution before transferring to a worker.
      const logo = document.createElement("canvas"); logo.width = logo.height = 64;
      logo.getContext("2d").drawImage(img, 0, 0, 64, 64);
      try { resolve([name, await createImageBitmap(logo)]); }
      catch { resolve([name, null]); }
    };
    img.onerror = () => resolve([name, null]);
    img.src = src;
  }))).then(Object.fromEntries);

  async function generate() {
    const id = ++requestId;
    rendering?.abort();
    const task = rendering = new AbortController();
    ready = null; save.disabled = true; canvas.hidden = true; $("receiptText").textContent = "";
    status.textContent = "正在生成小票…";
    try {
      if (!dateInput.value || !dateInput.validity.valid) throw new Error("请选择有效日期");
      const payload = { date: dateInput.value, source: $("receiptSource").value, period: $("receiptPeriod").value,
        splitEffort: $("receiptEffort").checked, splitSpeed: $("receiptSpeed").checked, sort: $("receiptSort").value };
      const bounds = window.ReceiptModel.range(payload.date, payload.period);
      $("receiptRangeHint").textContent = `${bounds.label} · ${payload.period === "week" ? "周一至周日" : "本机自然周期"} · 日期可选周期内任一天`;
      const data = await window.widget.getReceipt(payload);
      if (task.signal.aborted) return;
      const logos = await images;
      await document.fonts.ready;
      if (task.signal.aborted) return;
      const rendered = await window.ReceiptRenderTask.render(data, logos, task.signal);
      try {
        if (task.signal.aborted) return;
        canvas.width = rendered.bitmap.width; canvas.height = rendered.bitmap.height;
        canvas.getContext("bitmaprenderer").transferFromImageBitmap(rendered.bitmap);
      } finally { rendered.bitmap.close(); }
      canvas.hidden = false; canvas.setAttribute("aria-label", rendered.plain);
      $("receiptText").textContent = rendered.plain;
      ready = { data, png: rendered.png }; save.disabled = saving;
      status.textContent = `${data.rows.length ? "小票已生成" : "所选周期暂无记录，已生成空白小票"} · 可保存高清 PNG`;
    } catch (error) { if (!task.signal.aborted && id === requestId) status.textContent = `生成失败：${error.message || error}`; }
    finally { if (rendering === task) rendering = null; }
  }
  dateInput.addEventListener("change", generate);
  $("receiptPeriod").addEventListener("change", () => {
    const flags = window.ReceiptModel.defaults($("receiptPeriod").value);
    $("receiptEffort").checked = flags.splitEffort;
    $("receiptSpeed").checked = flags.splitSpeed;
    generate();
  });
  $("receiptEffort").addEventListener("change", generate);
  $("receiptSpeed").addEventListener("change", generate);
  $("receiptSource").addEventListener("change", generate);
  $("receiptSort").addEventListener("change", generate);
  $("receiptRefresh").addEventListener("click", generate);
  document.querySelector('[data-tab="receipt"]').addEventListener("click", generate);
  save.addEventListener("click", async () => {
    if (!ready || saving) return;
    saving = true; save.disabled = true;
    const id = requestId;
    try {
      const date = ready.data.range.key;
      const period = ready.data.period;
      const blob = ready.png;
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("无法读取 PNG")); reader.readAsDataURL(blob);
      });
      if (id !== requestId) return;
      if (window.widget.saveReceipt) {
        const result = await window.widget.saveReceipt({ date, period, image });
        if (id === requestId) status.textContent = result.canceled ? "已取消保存" : `已保存：${result.path}`;
      } else {
        const a = document.createElement("a"); a.href = image; a.download = `AI-${period}-账单-${date}.png`; a.click();
        if (id === requestId) status.textContent = "小票 PNG 已下载";
      }
    } catch (error) { if (id === requestId) status.textContent = `保存失败：${error.message || error}`; }
    finally { saving = false; save.disabled = !ready; }
  });
  // Populate a restored receipt tab as well as a newly opened one.
  window.widget.getSettings().then((settings) => { if (settings.activeTab === "receipt" && !requestId) generate(); }).catch(() => {});
})();
