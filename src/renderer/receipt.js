(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("receiptCanvas");
  const dateInput = $("receiptDate");
  const status = $("receiptStatus");
  const save = $("receiptSave");
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  dateInput.value = localDate(new Date());
  let requestId = 0, ready = null, saving = false;
  const money = (cents) => cents == null ? "未计价" : `US$${(cents / 100).toFixed(2)}`;
  const tokens = (n) => n >= 10000 ? `${(n / 10000).toFixed(2)}万` : n.toLocaleString("zh-CN");
  const provider = (model) => {
    const m = model.toLowerCase();
    if (/claude/.test(m)) return "anthropic";
    if (/grok/.test(m)) return "grok";
    if (/gpt|^o[134](?:-|$)|codex/.test(m)) return "openai";
    if (/gemini/.test(m)) return "gemini";
    if (/deepseek/.test(m)) return "deepseek";
    if (/qwen/.test(m)) return "qwen";
    if (/mistral|codestral/.test(m)) return "mistral";
    if (/llama/.test(m)) return "meta";
    if (/minimax/.test(m)) return "minimax";
    if (/kimi|moonshot/.test(m)) return "moonshot";
    if (/composer|^auto$|^default$/.test(m)) return "cursor";
    return null;
  };
  const images = Promise.all(Object.entries(window.ReceiptBrandIcons || {}).map(([name, src]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([name, img]);
    img.onerror = () => resolve([name, null]);
    img.src = src;
  }))).then(Object.fromEntries);

  async function draw(data) {
    const logos = await images;
    await document.fonts.ready;
    const groups = [...new Set(data.rows.map((r) => r.source))].map((source) => ({
      source, rows: data.rows.filter((r) => r.source === source),
    }));
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0, unpriced: 0, cost: 0, priced: false };
    for (const row of data.rows) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "count", "unpriced"]) total[key] += Number(row[key]) || 0;
      if (row.costCents != null) { total.cost += row.costCents; total.priced = true; }
    }
    const c = document.createElement("canvas");
    c.width = 1390;
    const modelFont = '32px "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
    const ctx = c.getContext("2d");
    // Wrap names before sizing the paper, so even long model IDs export in full.
    function wrap(text, width) {
      ctx.font = modelFont;
      const lines = []; let line = "";
      for (const char of text) {
        if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ""; }
        line += char;
      }
      lines.push(line); return lines;
    }
    let rowHeight = 0;
    for (const group of groups) {
      rowHeight += 74;
      for (const row of group.rows) { row.lines = wrap(row.model.toUpperCase(), 620); rowHeight += Math.max(68, row.lines.length * 42 + 20); }
    }
    if (!groups.length) rowHeight = 130;
    c.height = 1520 + rowHeight;
    const g = c.getContext("2d");
    const background = g.createLinearGradient(0, 0, 1390, c.height);
    background.addColorStop(0, "#9e96ee"); background.addColorStop(.48, "#b8a5e0"); background.addColorStop(1, "#f9c6d5");
    g.fillStyle = background; g.fillRect(0, 0, c.width, c.height);
    const paperBottom = c.height - 120;
    g.beginPath(); g.moveTo(130, 110); g.lineTo(1260, 110); g.lineTo(1260, paperBottom);
    for (let x = 1260; x > 130; x -= 20) { g.lineTo(x - 10, paperBottom + 10); g.lineTo(Math.max(130, x - 20), paperBottom); }
    g.closePath(); g.shadowColor = "#42334440"; g.shadowBlur = 65; g.shadowOffsetY = 35;
    g.fillStyle = "#f8f5ed"; g.fill(); g.shadowColor = "transparent"; g.shadowOffsetY = 0;
    g.save(); g.clip();
    let seed = 7;
    for (let i = 0; i < c.height * 8; i++) {
      seed = (seed * 16807) % 2147483647; const x = 130 + seed % 1130;
      seed = (seed * 16807) % 2147483647; const y = 110 + seed % (paperBottom - 110);
      g.fillStyle = i % 2 ? "#79694b09" : "#ffffff60"; g.fillRect(x, y, 1.6, 1.6);
    }
    g.restore();
    const left = 207, right = 1183, center = 695;
    function text(value, x, y, size = 32, bold = false, align = "left", color = "#20201e") {
      g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic";
      g.font = `${bold ? "700 " : ""}${size}px "Cascadia Mono", Consolas, "Microsoft YaHei", monospace`;
      g.fillText(String(value), x, y);
    }
    function divider(y) {
      g.beginPath(); g.strokeStyle = "#85837a"; g.lineWidth = 2.5; g.setLineDash([13, 10]);
      g.moveTo(left + 30, y); g.lineTo(right - 30, y); g.stroke(); g.setLineDash([]);
    }
    function icon(name, x, y, size) {
      if (logos[name]) g.drawImage(logos[name], x, y, size, size);
      else { g.strokeStyle = "#85837a"; g.lineWidth = 2; g.strokeRect(x + 5, y + 5, size - 10, size - 10); }
    }
    const printed = new Date(data.generatedAt);
    const [year, month, day] = data.date.split("-").map(Number);
    const dateLabel = `${year}年${month}月${day}日`;
    text("每日 AI 对账单", center, 244, 72, true, "center");
    text("Vibe something wonderful.", center, 315, 29, false, "center");
    text("日期", left, 386, 32, true); text(dateLabel, right, 386, 32, true, "right");
    text("出单时间", left, 443, 32, true); text(printed.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }), right, 443, 32, true, "right");
    divider(482);
    text("A P I  总费用", center, 548, 32, true, "center");
    const amount = total.priced || !total.count ? money(total.cost) : "未计价";
    text(amount, center, 692, amount.length > 12 ? 83 : amount.length > 9 ? 104 : 130, true, "center");
    text("API 等值估算 · 非实际账单", center, 755, 28, false, "center");
    divider(795);
    text("客户端 / 模型", left, 858, 31, true, "left", "#85837a");
    text("费用", right, 858, 31, true, "right", "#85837a");
    let y = 858;
    for (const group of groups) {
      y += 74;
      icon(group.source === "codex" ? "openai" : "cursor", left, y - 35, 43);
      text(group.source === "codex" ? "CODEX" : group.source.toUpperCase(), left + 65, y, 38, true);
      const priced = group.rows.some((r) => r.costCents != null);
      const partial = group.rows.some((r) => r.unpriced > 0);
      text(money(priced ? group.rows.reduce((sum, r) => sum + (r.costCents || 0), 0) : null) + (partial ? " *" : ""), right, y, 37, true, "right");
      for (const row of group.rows) {
        y += 68;
        icon(provider(row.model), left + 65, y - 28, 31);
        row.lines.forEach((line, index) => text(line, left + 111, y + index * 42, 32));
        text(money(row.costCents) + (row.unpriced && row.costCents != null ? " *" : ""), right, y, 32, false, "right");
        y += Math.max(0, row.lines.length * 42 + 20 - 68);
      }
    }
    if (!groups.length) { y += 90; text("这一天暂无用量记录", center, y, 32, false, "center", "#85837a"); y += 40; }
    divider(y + 40); y += 105;
    const input = total.input + total.cacheRead + total.cacheWrite;
    const stats = [
      ["总 Token 数", tokens(input + total.output)], ["输入（含缓存）", tokens(input)],
      ["输出", tokens(total.output)], ["缓存命中率", input ? `${(total.cacheRead / input * 100).toFixed(1)}%` : "—"],
      ["请求数", total.count.toLocaleString("zh-CN")],
    ];
    for (const [label, value] of stats) { text(label, left, y, 32, true); text(value, right, y, 32, true, "right"); y += 55; }
    divider(y - 15);
    text(total.unpriced ? `* ${total.unpriced} 次请求未计价，仅合计已知费用` : "AI 用量 · 每一份灵感，都有迹可循", center, y + 43, 27, false, "center");
    text("本机历史记录 · Cursor / Codex", center, y + 95, 27, false, "center");
    const plain = [`每日 AI 对账单 · ${dateLabel}`, `API 等值估算 · 非实际账单：${amount}`, ...groups.flatMap((group) => [group.source.toUpperCase(), ...group.rows.map((r) => `${r.model}  ${money(r.costCents)}${r.unpriced ? "（含未计价请求）" : ""}`)]), ...stats.map((s) => s.join("：")), total.unpriced ? `${total.unpriced} 次请求未计价，仅合计已知费用` : "本机历史记录"].join("\n");
    return { canvas: c, plain };
  }

  async function generate() {
    const id = ++requestId;
    ready = null; save.disabled = true; canvas.hidden = true; $("receiptText").textContent = "";
    status.textContent = "正在生成小票…";
    try {
      if (!dateInput.value || !dateInput.validity.valid) throw new Error("请选择有效日期");
      const payload = { date: dateInput.value, source: $("receiptSource").value };
      const data = await window.widget.getReceipt(payload);
      const rendered = await draw(data);
      if (id !== requestId) return;
      canvas.width = rendered.canvas.width; canvas.height = rendered.canvas.height;
      canvas.getContext("2d").drawImage(rendered.canvas, 0, 0);
      canvas.hidden = false; canvas.setAttribute("aria-label", rendered.plain);
      $("receiptText").textContent = rendered.plain;
      ready = data; save.disabled = saving;
      status.textContent = `${data.rows.length ? "小票已生成" : "当天暂无记录，已生成空白小票"} · 本机自然日 · 可保存高清 PNG`;
    } catch (error) { if (id === requestId) status.textContent = `生成失败：${error.message || error}`; }
  }
  dateInput.addEventListener("change", generate);
  $("receiptSource").addEventListener("change", generate);
  $("receiptRefresh").addEventListener("click", generate);
  document.querySelector('[data-tab="receipt"]').addEventListener("click", generate);
  save.addEventListener("click", async () => {
    if (!ready || saving) return;
    saving = true; save.disabled = true;
    const id = requestId;
    try {
      const image = canvas.toDataURL("image/png");
      const date = ready.date;
      if (window.widget.saveReceipt) {
        const result = await window.widget.saveReceipt({ date, image });
        if (id === requestId) status.textContent = result.canceled ? "已取消保存" : `已保存：${result.path}`;
      } else {
        const a = document.createElement("a"); a.href = image; a.download = `AI-账单-${date}.png`; a.click();
        if (id === requestId) status.textContent = "小票 PNG 已下载";
      }
    } catch (error) { if (id === requestId) status.textContent = `保存失败：${error.message || error}`; }
    finally { saving = false; save.disabled = !ready; }
  });
  // Populate a restored receipt tab as well as a newly opened one.
  window.widget.getSettings().then((settings) => { if (settings.activeTab === "receipt" && !requestId) generate(); }).catch(() => {});
})();
