const $ = (id) => document.getElementById(id);

let snapshot = { ok: false, loading: true, data: null };
let windowState = { fullscreen: false };
let modelUsage = null;
let modelUsageRequest = 0;
let renderFrame = null;
let chartTooltipContext = { series: [], metric: "total" };
let chartHoveredIndex = -1;
let chartTooltipFrame = null;
let chartTooltipVisible = false;
let chartTooltipPosition = { x: 0, y: 0, targetX: 0, targetY: 0 };
let settings = {
  opacity: 0.96,
  compact: false,
  orbMode: false,
  orbPool: "cursor-models",
  orbDisplayMode: "quota",
  intervalMs: 30_000,
  activeTab: "overview",
  modelRange: "month1",
  modelPrecision: "coarse",
  trendRange: "day",
  trendMetric: "total",
  trendBreakdown: false,
  dataSource: "all",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTokens(n, digits = 1) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(digits)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(digits)}K`;
  return String(Math.round(v));
}

function formatUsd(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "—";
  const dollars = Number(cents) / 100;
  const absolute = Math.abs(dollars);
  if (absolute >= 10_000_000) return `$${(dollars / 1_000_000).toFixed(3)}M`;
  if (absolute >= 10_000) return `$${(dollars / 1_000).toFixed(3)}K`;
  return `$${dollars.toFixed(2)}`;
}

function formatUsdRange(low, high) {
  if (low == null && high == null) return "—";
  const a = Number(low ?? high);
  const b = Number(high ?? low);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  if (Math.abs(b - a) < Math.max(0.01, Math.abs(a) * 0.005)) return formatUsd(a);
  return `${formatUsd(a)}–${formatUsd(b)}`;
}

function formatPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

function formatCursorPct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${v.toFixed(2)}%` : "—";
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatQuotaReset(ts) {
  if (!ts) return "";
  const reset = new Date(ts);
  const now = new Date();
  const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
  const sameDay = reset.getFullYear() === now.getFullYear()
    && reset.getMonth() === now.getMonth()
    && reset.getDate() === now.getDate();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const nextDay = reset.getFullYear() === tomorrow.getFullYear()
    && reset.getMonth() === tomorrow.getMonth()
    && reset.getDate() === tomorrow.getDate();
  if (sameDay) return `今天 ${time} 重置`;
  if (nextDay) return `明天 ${time} 重置`;
  return `${formatDate(ts)} ${time} 重置`;
}

function formatInteger(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function timeAgo(ts) {
  if (!ts) return "";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 8) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

function toneClass(pct) {
  if (pct >= 95) return "danger";
  if (pct >= 80) return "warning";
  return "healthy";
}

function quotaPools(d) {
  if (!d) return [];
  const pools = [];
  const addPool = (id, name, value, remaining, detail, precision, speedUsage, metadata = {}) => {
    const used = Number(value);
    if (!Number.isFinite(used)) return;
    pools.push({
      id,
      name,
      used: Math.min(100, Math.max(0, used)),
      remaining: Number.isFinite(Number(remaining)) ? Number(remaining) : Math.max(0, 100 - used),
      detail,
      precision,
      speedUsage: speedUsage || { normal: 0, fast: 0, unknown: 0, total: 0 },
      ...metadata,
    });
  };
  if (d.cursorModels) {
    addPool("cursor-models", "Cursor 模型池", d.cursorModels.percentUsed, d.cursorModels.percentRemaining, "Grok / Composer", 2, d.cursorModels.speedUsage);
  }
  if (d.otherModels) {
    addPool("cursor-api", "Cursor API 池", d.otherModels.percentUsed, d.otherModels.percentRemaining, "Claude / GPT 等", 2, d.otherModels.speedUsage);
  }
  const addCodexPool = (quota, fallbackSlot) => {
    if (!quota) return;
    const used = Number.isFinite(Number(quota.usedPercent)) ? Number(quota.usedPercent) : 100 - Number(quota.percentRemaining);
    const minutes = Number(quota.windowMinutes);
    const windowKey = Number.isFinite(minutes) && minutes > 0 ? String(minutes) : quota.slot || fallbackSlot;
    const reset = quota.expired
      ? "已重置 · 等待新请求同步"
      : formatQuotaReset(quota.resetsAt) || d.codex?.planName || "Codex";
    addPool(`codex-window-${windowKey}`, `Codex · ${quota.name || "额度窗口"}`, used, quota.percentRemaining, reset, 0, quota.speedUsage, {
      source: "codex",
      windowMinutes: Number.isFinite(minutes) ? minutes : null,
    });
  };
  codexQuotaWindows(d.codex)
    .forEach((quota, index) => addCodexPool(quota, `slot-${index}`));
  return pools;
}

function codexQuotaWindows(codex) {
  const windows = Array.isArray(codex?.quota?.windows) && codex.quota.windows.length
    ? codex.quota.windows
    : [codex?.quota?.primary, codex?.quota?.secondary].filter(Boolean);
  return windows
    .slice()
    .sort((a, b) => (Number(a.windowMinutes) || Number.MAX_SAFE_INTEGER) - (Number(b.windowMinutes) || Number.MAX_SAFE_INTEGER));
}

function selectedQuotaPool(pools) {
  return pools.find((pool) => pool.id === settings.orbPool)
    || (String(settings.orbPool).startsWith("codex-") ? pools.find((pool) => pool.source === "codex") : null)
    || pools[0];
}

function renderOrb(d) {
  const pools = quotaPools(d);
  const selected = selectedQuotaPool(pools);
  const displayMode = settings.orbDisplayMode === "speed" ? "speed" : "quota";
  const ring = $("orbRing");
  document.querySelectorAll("[data-orb-display]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orbDisplay === displayMode);
  });
  $("orbRefreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
  $("orbPrevBtn").disabled = pools.length < 2;
  $("orbNextBtn").disabled = pools.length < 2;
  if (!selected) {
    ring.style.setProperty("--orb-used", "0");
    ring.className = `orb-ring ${displayMode}-mode`;
    ring.removeAttribute("aria-valuenow");
    $("orbPercent").textContent = "—";
    $("orbPoolName").textContent = snapshot.loading ? "正在同步" : "暂无额度";
    $("orbPoolDetail").textContent = snapshot.error || "等待可用额度池";
    return;
  }
  const pct = (value) => selected.precision === 2 ? formatCursorPct(value) : formatPct(value);
  const speed = selected.speedUsage || {};
  const speedTotal = Math.max(0, Number(speed.total) || Number(speed.normal) + Number(speed.fast) + Number(speed.unknown) || 0);
  const normalPoints = speedTotal ? selected.used * Math.max(0, Number(speed.normal) || 0) / speedTotal : 0;
  const fastPoints = speedTotal ? selected.used * Math.max(0, Number(speed.fast) || 0) / speedTotal : 0;
  const unknownPoints = Math.max(0, selected.used - normalPoints - fastPoints);
  const normalEnd = normalPoints;
  const fastEnd = Math.min(selected.used, normalEnd + fastPoints);
  ring.style.setProperty("--orb-used", selected.used.toFixed(2));
  ring.style.setProperty("--orb-normal-end", `${normalEnd.toFixed(3)}%`);
  ring.style.setProperty("--orb-fast-end", `${fastEnd.toFixed(3)}%`);
  ring.style.setProperty("--orb-used-end", `${selected.used.toFixed(3)}%`);
  ring.className = `orb-ring ${displayMode}-mode${displayMode === "speed" && fastPoints > 0.001 ? " has-fast" : ""}`;
  ring.setAttribute("aria-valuenow", selected.used.toFixed(1));
  ring.setAttribute("aria-valuetext", `${selected.name}已用${formatPct(selected.used)}`);
  $("orbPercent").textContent = pct(selected.used);
  $("orbPoolName").textContent = selected.name;
  $("orbPoolDetail").textContent = displayMode === "speed"
    ? `普通 ${pct(normalPoints)} · Fast ${pct(fastPoints)}${unknownPoints > 0.01 ? ` · 未知 ${pct(unknownPoints)}` : ""}`
    : `剩余 ${pct(selected.remaining)} · ${selected.detail}`;
}

function changeOrbPool(direction) {
  const pools = quotaPools(snapshot.data);
  if (pools.length < 2) return;
  const selected = selectedQuotaPool(pools);
  const current = Math.max(0, pools.findIndex((pool) => pool.id === selected?.id));
  const next = pools[(current + direction + pools.length) % pools.length];
  settings.orbPool = next.id;
  window.widget.saveSettings({ orbPool: next.id });
  renderOrb(snapshot.data);
}

function poolHtml(pool, kind, extra = "") {
  const used = Math.min(100, Math.max(0, Number(pool.percentUsed) || 0));
  return `
    <div class="quota-head">
      <div class="quota-icon ${kind}" aria-hidden="true">${kind === "cursor" ? "C" : "AI"}</div>
      <div class="quota-title">
        <h3>${escapeHtml(pool.name)}</h3>
        <span>${escapeHtml(pool.hint)}</span>
      </div>
      <div class="quota-remain ${toneClass(used)}"><b>${formatCursorPct(pool.percentRemaining)}</b><span>剩余</span></div>
    </div>
    <progress class="quota-progress ${kind}" max="100" value="${used}">${used}%</progress>
    <div class="quota-stats">
      <span>已用 <b>${formatCursorPct(pool.percentUsed)}</b></span>
      <span class="token-pair">总 Token <b>${formatTokens(pool.tokens?.total)}</b><small>有效 ${formatTokens(pool.tokens?.effective)}</small></span>
    </div>
    ${extra}
  `;
}

function costPartsHtml(costs) {
  const value = costs || {};
  return `<div class="quota-cost-parts">
    <span>输入 ${formatUsd(value.inputCostCents)}</span>
    <span>写缓存 ${formatUsd(value.cacheWriteCostCents)}</span>
    <span>读缓存 ${formatUsd(value.cacheReadCostCents)}</span>
    <span>输出 ${formatUsd(value.outputCostCents)}</span>
  </div>`;
}

function codexQuotaWindowsHtml(codex) {
  const windows = codexQuotaWindows(codex);
  if (!windows.length) return `<div class="empty-state codex-window-empty">当前套餐额度窗口暂不可用</div>`;
  return `<div class="codex-window-list">${windows.map((quota) => {
    const used = Math.min(100, Math.max(0, Number(quota.usedPercent) || 0));
    const remaining = Number.isFinite(Number(quota.percentRemaining)) ? Number(quota.percentRemaining) : Math.max(0, 100 - used);
    const name = quota.name || (quota.windowMinutes ? `${quota.windowMinutes} 分钟额度` : "额度窗口");
    const reset = quota.expired
      ? "已重置 · 等待新请求同步"
      : formatQuotaReset(quota.resetsAt) || "等待重置时间";
    return `<section class="codex-window-row" aria-label="${escapeHtml(name)}">
      <div class="codex-window-head">
        <span><b>${escapeHtml(name)}</b><small>${escapeHtml(reset)}</small></span>
        <strong class="${toneClass(used)}">${formatPct(remaining)} <em>剩余</em></strong>
      </div>
      <progress class="quota-progress codex" max="100" value="${used}" aria-label="${escapeHtml(name)}已用比例">${used}%</progress>
      <div class="codex-window-stats"><span>已用 <b>${formatPct(used)}</b></span><span>剩余 <b>${formatPct(remaining)}</b></span></div>
    </section>`;
  }).join("")}</div>`;
}

function renderOverview(d) {
  const combined = d.combined || {};
  const codex = d.codex;
  const cursorIncluded = d.otherModels?.includedCents || {};
  const codexCost = codex?.apiEquivalent || {};
  const cursorPoolCost = d.cursorModels?.apiEquivalent || {};
  const cursorPoolQuota = d.cursorModels?.quotaEstimate || {};
  const otherPoolCost = d.otherModels?.apiEquivalent || {};
  const otherPoolQuota = d.otherModels?.quotaEstimate || {};
  $("heroGrid").innerHTML = `
    <div class="hero-metric primary"><span>今日总 Token（含缓存）</span><strong>${formatTokens(combined.tokens?.today?.total)}</strong><small>有效 ${formatTokens(combined.tokens?.today?.effective)} · 写缓存 ${formatTokens(combined.tokens?.today?.cacheWrite)} · 读缓存 ${formatTokens(combined.tokens?.today?.cacheRead)} · 近 1 小时总 ${formatTokens(combined.tokens?.h1?.total)}</small></div>
    <div class="hero-metric"><span>Cursor 模型池</span><strong>${formatUsd(cursorPoolQuota.usedCents)}</strong><small>${cursorPoolQuota.inferredTotalCents == null ? "池总额等待用量比例" : `按比例反推总额 ${formatUsd(cursorPoolQuota.inferredTotalCents)}`}</small></div>
    <div class="hero-metric"><span>其他 API 模型池</span><strong>${formatUsd(otherPoolQuota.usedCents)}</strong><small>套餐总额 ${formatUsd(otherPoolQuota.packageTotalCents)} · 官方已计 ${formatUsd(cursorIncluded.used)}</small></div>
  `;

  if (d.cursorModels) {
    $("cursorPool").innerHTML = poolHtml(
      d.cursorModels,
      "cursor",
      `<div class="quota-credit"><span>本周期 API 等效</span><b>${formatUsd(cursorPoolCost.equivalentCostCents)}</b></div>
       ${costPartsHtml(cursorPoolCost)}
       <div class="quota-credit"><span>按 ${formatCursorPct(d.cursorModels.percentUsed)} 反推池总额</span><b>${formatUsd(cursorPoolQuota.inferredTotalCents)}</b></div>
       ${d.cursorModels.message ? `<div class="quota-message">${escapeHtml(d.cursorModels.message)}</div>` : ""}`
    );
  } else {
    $("cursorPool").innerHTML = `<div class="empty-state">Cursor 当前额度暂不可用</div>`;
  }

  if (d.otherModels) {
    const included = d.otherModels.includedCents || {};
    const otherExtra = `
      <div class="quota-credit">
        <span>套餐额度</span>
        <b>${formatUsd(included.used)} <em>/ ${formatUsd(included.limit)}</em></b>
      </div>
      <div class="quota-credit">
        <span>第三方模型 API 等效</span>
        <b>${formatUsd(otherPoolCost.equivalentCostCents)}</b>
      </div>
      ${costPartsHtml(otherPoolCost)}
      <div class="quota-credit">
        <span>按 ${formatCursorPct(d.otherModels.percentUsed)} 反推池总额</span>
        <b>${formatUsd(otherPoolQuota.inferredTotalCents)}</b>
      </div>
      ${d.onDemand?.enabled ? `<div class="quota-message">按需已用 ${formatUsd(d.onDemand.usedCents)}${d.onDemand.limitCents != null ? ` · 上限 ${formatUsd(d.onDemand.limitCents)}` : ""}</div>` : ""}
    `;
    $("otherPool").innerHTML = poolHtml(d.otherModels, "other", otherExtra);
  } else {
    $("otherPool").innerHTML = `<div class="empty-state">Cursor 其他模型额度暂不可用</div>`;
  }

  if (codex) {
    const codexWindows = codexQuotaWindows(codex);
    $("codexPool").innerHTML = `
      <div class="quota-head">
        <div class="quota-icon codex" aria-hidden="true">OX</div>
        <div class="quota-title"><h3>Codex</h3><span>${escapeHtml(codex.planName)} · 本机会话日志</span></div>
        <div class="quota-remain codex-window-count"><b>${formatInteger(codexWindows.length)}</b><span>额度窗口</span></div>
      </div>
      ${codexQuotaWindowsHtml(codex)}
      <div class="quota-stats codex-token-stats"><span>短周期总 Token <b>${formatTokens(codex.tokens?.period?.total)}</b></span><span class="token-pair">有效 <b>${formatTokens(codex.tokens?.period?.effective)}</b></span></div>
      <div class="quota-credit"><span>美元等效（Fast 按 2.5×）</span><b>${formatUsdRange(codexCost.equivalentCostLowCents, codexCost.equivalentCostHighCents)} <em>${codexCost.inferredTotalCents == null ? "" : `/ ${formatUsdRange(codexCost.inferredTotalLowCents, codexCost.inferredTotalHighCents)}`}</em></b></div>
      ${costPartsHtml(codexCost)}
      <div class="quota-message">${escapeHtml(codex.periodLabel)} · ${formatInteger(codex.eventCount)} 次 · tier：服务端 ${formatInteger(codex.tierEvidence?.response)} / 本地 ${formatInteger(codex.tierEvidence?.local)} / 未知 ${formatInteger(codex.tierEvidence?.unknown)} · ${codex.files} 个本地会话文件</div>
    `;
  } else {
    $("codexPool").innerHTML = `<div class="empty-state">未找到可读取的 Codex 本机会话</div>`;
  }

  const last = combined.lastEvent || d.lastEvent;
  const lastEffective = last ? (last.tokens?.input || 0) + (last.tokens?.output || 0) : 0;
  const lastTotal = lastEffective + (last?.tokens?.cacheRead || 0) + (last?.tokens?.cacheWrite || 0);
  const lastCost = last?.equivalentCostCents == null ? "价格不可用" : `${formatUsd(last.equivalentCostCents)} 美元等效`;
  $("recentPanel").innerHTML = last
    ? `<div class="recent-icon">↗</div><div><span>最近一次调用 · ${last.source === "codex" ? "Codex" : "Cursor"}</span><b>${escapeHtml(last.model)}${last.effort ? ` · ${escapeHtml(last.effort)}` : ""}</b><small>总 ${formatTokens(lastTotal)} Token · 有效 ${formatTokens(lastEffective)} · 写缓存 ${formatTokens(last.tokens?.cacheWrite)} / ${formatUsd(last.cacheWriteCostCents)} · 读缓存 ${formatTokens(last.tokens?.cacheRead)} / ${formatUsd(last.cacheReadCostCents)} · ${lastCost} · ${timeAgo(last.at)}</small></div>`
    : `<div class="empty-state">本周期还没有可显示的用量事件</div>`;
}

const precisionNotes = {
  coarse: "只按基础模型合并，Fast 与 thinking effort 均不拆分。",
  speed: "同一模型拆分标准 / Fast，thinking effort 仍合并。",
  exact: "Fast 与每一种 thinking effort 都作为独立型号统计。",
};

function renderModels(d) {
  const precision = settings.modelPrecision || "coarse";
  const source = settings.dataSource || "all";
  const activeUsage = modelUsage?.key === settings.modelRange ? modelUsage : null;
  const view = activeUsage?.sources?.[source] || activeUsage?.sources?.all;
  if (!view) {
    const option = $("modelRangeSelect").selectedOptions[0];
    $("modelCount").textContent = "读取中";
    $("modelSubtitle").textContent = `${option?.textContent || "所选范围"} · 正在聚合持久化历史`;
    $("modelList").innerHTML = `<div class="empty-state">正在计算模型用量…</div>`;
    return;
  }
  const rows = view.modelBreakdowns?.[precision] || [];
  $("modelCount").textContent = `${formatInteger(view.eventCount)} 次`;
  $("modelSubtitle").textContent = `${view.label || "全部"} · ${view.periodLabel || "当前周期"} · 按总 Token（含缓存）排序`;
  const unknownSpeed = source !== "cursor" ? " Codex 优先持久化服务端响应 service_tier；抓不到响应时回退到本地请求记录，旧记录可能显示速度未知。" : "";
  $("precisionNote").textContent = precisionNotes[precision] + unknownSpeed;
  document.querySelectorAll("[data-precision]").forEach((button) => {
    button.classList.toggle("active", button.dataset.precision === precision);
  });
  document.querySelectorAll("[data-source]").forEach((button) => {
    button.classList.toggle("active", button.dataset.source === source);
  });
  if (!rows.length) {
    $("modelList").innerHTML = `<div class="empty-state">暂无模型明细</div>`;
    return;
  }
  const max = Math.max(1, ...rows.map((row) => Number(row.total) || 0));
  $("modelList").innerHTML = rows
    .map((row, index) => `
      <article class="model-row">
        <div class="model-rank">${String(index + 1).padStart(2, "0")}</div>
        <div class="model-main">
          <div class="model-title"><b title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</b><span>${formatTokens(row.total)} 总 Token</span></div>
          <progress class="model-progress ${row.fast ? "fast" : ""}" max="${max}" value="${Math.max(0, row.total || 0)}"></progress>
          <div class="model-meta"><span>${formatInteger(row.count)} 次 · 有效 ${formatTokens(row.effective)}</span><span>${view.costAvailable ? formatUsd(row.costCents) : `推理 ${formatTokens(row.reasoning)}`}</span></div>
          <div class="model-detail-grid">
            <span><small>输入 · ${formatUsd(row.inputCostCents)}</small><b>${formatTokens(row.input)}</b></span>
            <span><small>缓存写入 · ${formatUsd(row.cacheWriteCostCents)}</small><b>${formatTokens(row.cacheWrite)}</b></span>
            <span><small>缓存读取 · ${formatUsd(row.cacheReadCostCents)}</small><b>${formatTokens(row.cacheRead)}</b></span>
            <span><small>输出 · ${formatUsd(row.outputCostCents)}</small><b>${formatTokens(row.output)}</b></span>
            <span><small>推理 Token</small><b>${formatTokens(row.reasoning)}</b></span>
            <span><small>API 等效合计</small><b>${formatUsd(row.costCents)}</b></span>
          </div>
        </div>
      </article>`)
    .join("");
}

async function loadModelRange(range) {
  const request = ++modelUsageRequest;
  settings.modelRange = range;
  modelUsage = null;
  window.widget.saveSettings({ modelRange: range });
  if (snapshot.data) renderModels(snapshot.data);
  try {
    const next = await window.widget.getModelUsage(range);
    if (request !== modelUsageRequest) return;
    modelUsage = next;
    if (snapshot.data) renderModels(snapshot.data);
  } catch (error) {
    if (request !== modelUsageRequest) return;
    $("modelCount").textContent = "失败";
    $("modelList").innerHTML = `<div class="empty-state">模型历史读取失败：${escapeHtml(error?.message || error)}</div>`;
  }
}

function formatMetric(value, metric) {
  return metric === "equivalentCostCents" ? formatUsd(value, true) : formatTokens(value);
}

function axisValue(value, metric) {
  if (metric === "equivalentCostCents") return formatUsd(value, true);
  return formatTokens(value, 0);
}

function chartSegmentDefinitions(metric) {
  if (metric === "equivalentCostCents") {
    return [
      { key: "inputCostCents", label: "输入", className: "input" },
      { key: "cacheWriteCostCents", label: "缓存写入", className: "cache-write" },
      { key: "cacheReadCostCents", label: "缓存读取", className: "cache-read" },
      { key: "outputCostCents", label: "输出", className: "output" },
    ];
  }
  if (metric === "effective") {
    return [
      { key: "input", label: "输入", className: "input" },
      { key: "output", label: "输出", className: "output" },
    ];
  }
  return [
    { key: "input", label: "输入", className: "input" },
    { key: "cacheWrite", label: "缓存写入", className: "cache-write" },
    { key: "cacheRead", label: "缓存读取", className: "cache-read" },
    { key: "output", label: "输出", className: "output" },
  ];
}

function chartSvg(series, metric, range, breakdown = false) {
  if (!series?.length) return `<div class="empty-state">暂无趋势数据</div>`;
  const fullscreen = Boolean(windowState.fullscreen);
  const width = fullscreen ? 1400 : 400;
  const height = fullscreen ? 460 : 236;
  const left = fullscreen ? 76 : 45;
  const top = fullscreen ? 24 : 14;
  const plotWidth = fullscreen ? width - left - 28 : 344;
  const plotHeight = fullscreen ? height - top - 76 : 170;
  const baseY = top + plotHeight;
  const segmentDefs = chartSegmentDefinitions(metric);
  const segmentValue = (item, def) => Number(item[def.key]) || 0;
  const values = series.map((item) => breakdown
    ? segmentDefs.reduce((sum, def) => sum + Math.max(0, segmentValue(item, def)), 0)
    : Math.max(0, Number(item[metric]) || 0));
  const maxValue = Math.max(...values, 1);
  const slot = plotWidth / series.length;
  const gap = fullscreen
    ? range === "month" ? 7 : range === "day" ? 12 : 32
    : range === "month" ? 2.2 : range === "day" ? 3.2 : 8;
  const barWidth = Math.max(3, slot - gap);
  const labelIndexes = range === "week"
    ? new Set(series.map((_item, index) => index))
    : range === "month"
      ? new Set([0, 4, 9, 14, 19, 24, 29])
      : new Set([0, 4, 8, 12, 16, 20, 23]);
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const y = baseY - ratio * plotHeight;
      return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"/><text class="axis-y" x="${left - 7}" y="${y + 4}" text-anchor="end">${escapeHtml(axisValue(maxValue * ratio, metric))}</text>`;
    })
    .join("");
  const bars = series
    .map((item, index) => {
      const value = values[index];
      const barHeight = value ? Math.max(2, (value / maxValue) * plotHeight) : 0;
      const x = left + index * slot + (slot - barWidth) / 2;
      const label = labelIndexes.has(index)
        ? `<text class="axis-x" x="${x + barWidth / 2}" y="${baseY + 22}" text-anchor="middle">${escapeHtml(item.shortLabel)}</text>`
        : "";
      const hitX = left + index * slot;
      const hitbox = `<rect class="chart-hitbox" x="${hitX.toFixed(2)}" y="${top}" width="${slot.toFixed(2)}" height="${plotHeight}" />`;
      if (!breakdown) {
        const y = baseY - barHeight;
        return `<g class="chart-column" data-chart-index="${index}">${hitbox}<rect class="chart-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="${Math.min(4, barWidth / 2)}"></rect>${label}</g>`;
      }
      let y = baseY;
      const rects = segmentDefs.map((def, segmentIndex) => {
        const segment = Math.max(0, segmentValue(item, def));
        const heightValue = segment ? Math.max(1, segment / maxValue * plotHeight) : 0;
        y -= heightValue;
        return `<rect class="chart-segment ${def.className}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${heightValue.toFixed(2)}" rx="${segmentIndex === segmentDefs.length - 1 ? Math.min(3, barWidth / 2) : 0}"></rect>`;
      }).join("");
      return `<g class="chart-column" data-chart-index="${index}">${hitbox}${rects}${label}</g>`;
    })
    .join("");
  return `<svg class="bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="消耗柱状图">${grid}${bars}</svg>`;
}

function renderTrends(d) {
  const range = settings.trendRange || "day";
  const source = settings.dataSource || "all";
  const view = d.sources?.[source] || d.sources?.all || { trends: d.trends, costAvailable: true, label: "Cursor" };
  let metric = settings.trendMetric || "total";
  if (metric === "costCents") metric = "equivalentCostCents";
  const breakdown = Boolean(settings.trendBreakdown);
  if (metric === "equivalentCostCents" && !view.costAvailable) metric = "total";
  if (breakdown && metric === "effective") metric = "total";
  const series = view.trends?.[range] || [];
  const total = series.reduce((sum, item) => sum + (Number(item[metric]) || 0), 0);
  const peak = series.reduce((best, item) => !best || (item[metric] || 0) > (best[metric] || 0) ? item : best, null);
  const resolution = range === "day" ? "今天 · 每小时聚合" : range === "week" ? "最近 7 天 · 每日聚合" : "最近 30 天 · 每日聚合";
  $("trendResolution").textContent = `${view.label || "全部"} · ${resolution}`;
  $("trendTotal").textContent = formatMetric(total, metric);
  hideChartTooltip();
  chartTooltipContext = { series, metric };
  $("trendChart").innerHTML = chartSvg(series, metric, range, breakdown);
  $("legendItems").innerHTML = breakdown
    ? `<span class="legend-key input"><i></i>输入</span><span class="legend-key cache-write"><i></i>缓存写入</span><span class="legend-key cache-read"><i></i>缓存读取</span><span class="legend-key output"><i></i>输出</span>`
    : `<i></i><b id="legendText">${metric === "effective" ? "有效 Token 新增" : metric === "total" ? "总 Token 新增（含缓存）" : "美元等效费用新增"}</b>`;
  $("chartPeak").textContent = peak ? `峰值 ${peak.shortLabel} · ${formatMetric(peak[metric], metric)}` : "峰值 —";
  document.querySelectorAll("[data-range]").forEach((button) => button.classList.toggle("active", button.dataset.range === range));
  document.querySelectorAll("[data-metric]").forEach((button) => {
    button.disabled = button.dataset.metric === "equivalentCostCents" && !view.costAvailable;
    button.classList.toggle("active", button.dataset.metric === metric);
  });
  document.querySelectorAll("[data-source]").forEach((button) => button.classList.toggle("active", button.dataset.source === source));
  $("breakdownBtn").classList.toggle("active", breakdown);
  $("breakdownBtn").setAttribute("aria-pressed", String(breakdown));
  const coverage = Number(view.costCoveragePercent);
  const priceDate = d.pricing?.fetchedAt ? formatDate(d.pricing.fetchedAt) : "内置";
  $("trendFootnote").textContent = `美元等效价格按事件入库时锁定 · 覆盖 ${Number.isFinite(coverage) ? formatPct(coverage) : "—"} · 价表 ${priceDate} · Codex 走 OpenAI 官方价并按 Fast 2.5×；Cursor 走 Cursor 官方价。`;
}

function chartTooltipTarget(clientX, clientY) {
  const tooltip = $("chartTooltip");
  const rect = tooltip.getBoundingClientRect();
  const gap = 16;
  const edge = 10;
  let x = clientX + gap;
  let y = clientY + gap;
  if (x + rect.width > window.innerWidth - edge) x = clientX - rect.width - gap;
  if (y + rect.height > window.innerHeight - edge) y = clientY - rect.height - gap;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - rect.width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - rect.height - edge)),
  };
}

function animateChartTooltip() {
  chartTooltipFrame = null;
  if (!chartTooltipVisible) return;
  const position = chartTooltipPosition;
  position.x += (position.targetX - position.x) * 0.3;
  position.y += (position.targetY - position.y) * 0.3;
  if (Math.abs(position.targetX - position.x) < 0.1) position.x = position.targetX;
  if (Math.abs(position.targetY - position.y) < 0.1) position.y = position.targetY;
  $("chartTooltip").style.translate = `${position.x.toFixed(2)}px ${position.y.toFixed(2)}px`;
  if (position.x !== position.targetX || position.y !== position.targetY) {
    chartTooltipFrame = requestAnimationFrame(animateChartTooltip);
  }
}

function moveChartTooltip(clientX, clientY, immediate = false) {
  const target = chartTooltipTarget(clientX, clientY);
  chartTooltipPosition.targetX = target.x;
  chartTooltipPosition.targetY = target.y;
  if (immediate) {
    chartTooltipPosition.x = target.x;
    chartTooltipPosition.y = target.y;
    $("chartTooltip").style.translate = `${target.x.toFixed(2)}px ${target.y.toFixed(2)}px`;
  }
  if (chartTooltipFrame === null) chartTooltipFrame = requestAnimationFrame(animateChartTooltip);
}

function fillChartTooltip(index) {
  const item = chartTooltipContext.series[index];
  if (!item) return false;
  const metric = chartTooltipContext.metric;
  const definitions = chartSegmentDefinitions(metric);
  const parts = definitions.map((definition) => ({
    ...definition,
    value: Math.max(0, Number(item[definition.key]) || 0),
  }));
  const partTotal = parts.reduce((sum, part) => sum + part.value, 0);
  $("chartTooltipLabel").textContent = item.label || item.shortLabel || "该时段";
  $("chartTooltipTotal").textContent = formatMetric(item[metric], metric);
  $("chartTooltipRows").innerHTML = parts.map((part) => {
    const percent = partTotal > 0 ? part.value / partTotal * 100 : 0;
    return `<div class="chart-tooltip-row ${part.className}"><span><i></i>${escapeHtml(part.label)}</span><b>${escapeHtml(formatMetric(part.value, metric))}</b><em>${percent.toFixed(percent >= 10 ? 0 : 1)}%</em></div>`;
  }).join("");
  $("chartTooltipMeta").innerHTML = `<span>${formatInteger(item.count)} 次调用</span><span>${metric === "equivalentCostCents" ? "事件价格已锁定" : metric === "effective" ? "不含缓存命中" : "包含缓存命中"}</span>`;
  return true;
}

function hideChartTooltip() {
  if (!$("chartTooltip")) return;
  chartTooltipVisible = false;
  chartHoveredIndex = -1;
  $("chartTooltip").classList.remove("visible");
  $("chartTooltip").setAttribute("aria-hidden", "true");
  $("trendChart")?.querySelector(".bar-chart")?.classList.remove("has-hover");
  $("trendChart")?.querySelectorAll(".chart-column.is-hovered").forEach((column) => column.classList.remove("is-hovered"));
  if (chartTooltipFrame !== null) {
    cancelAnimationFrame(chartTooltipFrame);
    chartTooltipFrame = null;
  }
}

function handleChartPointerMove(event) {
  const column = event.target.closest?.(".chart-column");
  if (!column || !$("trendChart").contains(column)) {
    hideChartTooltip();
    return;
  }
  const index = Number(column.dataset.chartIndex);
  const firstShow = !chartTooltipVisible;
  if (index !== chartHoveredIndex) {
    if (!fillChartTooltip(index)) return;
    chartHoveredIndex = index;
    $("trendChart").querySelector(".chart-column.is-hovered")?.classList.remove("is-hovered");
    column.classList.add("is-hovered");
    $("trendChart").querySelector(".bar-chart")?.classList.add("has-hover");
  }
  chartTooltipVisible = true;
  $("chartTooltip").classList.add("visible");
  $("chartTooltip").setAttribute("aria-hidden", "false");
  moveChartTooltip(event.clientX, event.clientY, firstShow);
}

function renderActiveView(d) {
  if (!d) return;
  if (settings.activeTab === "models") renderModels(d);
  else if (settings.activeTab === "trends") renderTrends(d);
  else renderOverview(d);
}

function setActiveTab(tab, persist = false) {
  const valid = ["overview", "models", "trends"].includes(tab) ? tab : "overview";
  settings.activeTab = valid;
  if (valid !== "trends") hideChartTooltip();
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === valid));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${valid}View`));
  if (persist) {
    window.widget.saveSettings({ activeTab: valid });
    renderActiveView(snapshot.data);
  }
}

function renderStatus() {
  const d = snapshot.data;
  const dot = $("liveDot");
  $("refreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
  if (snapshot.loading) {
    dot.className = "live-dot syncing";
    $("statusText").textContent = d ? "正在同步最新用量…" : "正在连接 Cursor 用量接口…";
    $("syncCountdown").textContent = "";
    return;
  }
  if (!snapshot.ok) {
    dot.className = "live-dot error";
    $("statusText").textContent = d ? `离线数据 · ${snapshot.error || "同步失败"}` : snapshot.error || "等待数据";
    $("syncCountdown").textContent = d ? timeAgo(d.fetchedAt) : "";
    return;
  }
  dot.className = "live-dot";
  const cursorState = d?.sourceStatus?.cursor;
  const codexState = d?.sourceStatus?.codex;
  const sourceText = cursorState?.ok && codexState?.ok
    ? "Cursor 云端 + Codex 本机"
    : cursorState?.cached && codexState?.ok
      ? "Cursor 本地缓存 + Codex 本机"
      : cursorState?.ok
        ? "Cursor 云端"
        : codexState?.ok
          ? "Codex 本机"
          : "本地缓存";
  $("statusText").textContent = `${sourceText} · ${timeAgo(d?.fetchedAt)}`;
  const seconds = Math.max(0, Math.ceil(((d?.fetchedAt || Date.now()) + Number(settings.intervalMs || 30_000) - Date.now()) / 1000));
  $("syncCountdown").textContent = `${seconds}s 后刷新`;
}

function render() {
  const orbMode = Boolean(settings.orbMode) && !windowState.fullscreen;
  document.body.classList.toggle("compact", Boolean(settings.compact) && !windowState.fullscreen && !orbMode);
  document.body.classList.toggle("fullscreen", Boolean(windowState.fullscreen));
  document.body.classList.toggle("orb-mode", orbMode);
  $("compactBtn").classList.toggle("active", Boolean(settings.compact) && !windowState.fullscreen && !orbMode);
  $("compactBtn").disabled = Boolean(windowState.fullscreen);
  $("orbBtn").classList.toggle("active", orbMode);
  $("orbBtn").disabled = Boolean(windowState.fullscreen);
  $("fullscreenBtn").classList.toggle("active", Boolean(windowState.fullscreen));
  $("fullscreenBtn").textContent = windowState.fullscreen ? "↙" : "⛶";
  $("fullscreenBtn").title = windowState.fullscreen ? "退出全屏（Esc / F11）" : "全屏仪表盘（F11）";
  $("opacity").value = Math.round((settings.opacity ?? 0.96) * 100);
  $("intervalSelect").value = String(settings.intervalMs || 30_000);
  $("modelRangeSelect").value = settings.modelRange || "month1";
  setActiveTab(settings.activeTab, false);
  renderStatus();
  const d = snapshot.data;
  renderOrb(d);
  if (!d) return;
  if (d.modelUsage?.key === settings.modelRange && modelUsage?.key !== settings.modelRange) modelUsage = d.modelUsage;
  $("planBadge").textContent = d.codex && d.cursorModels ? "双源" : d.codex ? "Codex" : d.planName || "Cursor";
  const accountParts = [];
  if (d.email) accountParts.push(d.email);
  if (d.cursorModels) accountParts.push(`Cursor ${d.planName || ""}`.trim());
  if (d.codex) accountParts.push(`Codex ${d.codex.planName || ""}`.trim());
  $("planLine").textContent = accountParts.join(" · ") || "本机用量历史";
  $("priceBtn").title = d.pricing?.fetchedAt
    ? `手动更新官方价目表 · 当前 ${new Date(d.pricing.fetchedAt).toLocaleString("zh-CN")}`
    : "手动更新官方价目表";
  if (!orbMode) renderActiveView(d);
}

function scheduleRender() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

async function setFullscreen(force) {
  try {
    const next = await window.widget.toggleFullscreen(force);
    windowState = { ...windowState, ...next };
    render();
  } catch (error) {
    console.error("切换全屏失败", error);
  }
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab, true));
});
$("trendChart").addEventListener("pointermove", handleChartPointerMove, { passive: true });
$("trendChart").addEventListener("pointerleave", hideChartTooltip);
document.querySelectorAll("[data-source]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.dataSource = button.dataset.source;
    const view = snapshot.data?.sources?.[settings.dataSource];
    const partial = { dataSource: settings.dataSource };
    if (settings.trendMetric === "equivalentCostCents" && view && !view.costAvailable) {
      settings.trendMetric = "total";
      partial.trendMetric = "total";
    }
    window.widget.saveSettings(partial);
    renderActiveView(snapshot.data);
  });
});
document.querySelectorAll("[data-precision]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.modelPrecision = button.dataset.precision;
    window.widget.saveSettings({ modelPrecision: settings.modelPrecision });
    if (snapshot.data) renderModels(snapshot.data);
  });
});
document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.trendRange = button.dataset.range;
    window.widget.saveSettings({ trendRange: settings.trendRange });
    if (snapshot.data) renderTrends(snapshot.data);
  });
});
document.querySelectorAll("[data-metric]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.trendMetric = button.dataset.metric;
    window.widget.saveSettings({ trendMetric: settings.trendMetric });
    if (snapshot.data) renderTrends(snapshot.data);
  });
});

$("breakdownBtn").addEventListener("click", () => {
  settings.trendBreakdown = !settings.trendBreakdown;
  const partial = { trendBreakdown: settings.trendBreakdown };
  if (settings.trendBreakdown && settings.trendMetric === "effective") {
    settings.trendMetric = "total";
    partial.trendMetric = "total";
  }
  window.widget.saveSettings(partial);
  if (snapshot.data) renderTrends(snapshot.data);
});

$("refreshBtn").addEventListener("click", () => window.widget.refresh());
$("priceBtn").addEventListener("click", () => window.widget.refreshPricing());
$("fullscreenBtn").addEventListener("click", () => setFullscreen());
$("exitFullscreenBtn").addEventListener("click", () => setFullscreen(false));
$("orbBtn").addEventListener("click", () => window.widget.saveSettings({ orbMode: true, compact: false }));
$("closeBtn").addEventListener("click", () => window.widget.hide());
$("dashBtn").addEventListener("click", () => window.widget.openDashboard());
$("compactBtn").addEventListener("click", () => window.widget.saveSettings({ compact: !settings.compact, orbMode: false }));
$("modelRangeSelect").addEventListener("change", (event) => loadModelRange(event.target.value));
$("orbPrevBtn").addEventListener("click", () => changeOrbPool(-1));
$("orbNextBtn").addEventListener("click", () => changeOrbPool(1));
document.querySelectorAll("[data-orb-display]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.orbDisplayMode = button.dataset.orbDisplay;
    window.widget.saveSettings({ orbDisplayMode: settings.orbDisplayMode });
    renderOrb(snapshot.data);
  });
});
$("orbRestoreBtn").addEventListener("click", () => window.widget.saveSettings({ orbMode: false }));
$("orbRefreshBtn").addEventListener("click", () => window.widget.refresh());
$("orbHideBtn").addEventListener("click", () => window.widget.hide());
$("intervalSelect").addEventListener("change", (event) => {
  settings.intervalMs = Number(event.target.value);
  window.widget.saveSettings({ intervalMs: settings.intervalMs });
  renderStatus();
});
$("opacity").addEventListener("input", (event) => {
  settings.opacity = Number(event.target.value) / 100;
  window.widget.setOpacity(settings.opacity);
});

window.widget.onSnapshot((next) => {
  snapshot = next;
  if (next.data?.modelUsage?.key === settings.modelRange) modelUsage = next.data.modelUsage;
  scheduleRender();
});
window.widget.onSettings((next) => {
  settings = { ...settings, ...next };
  scheduleRender();
});
window.widget.onWindowState((next) => {
  windowState = { ...windowState, ...next };
  scheduleRender();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "F11" || (event.key === "Escape" && windowState.fullscreen)) {
    event.preventDefault();
    setFullscreen(event.key === "Escape" ? false : undefined);
  } else if (settings.orbMode && event.key === "Escape") {
    event.preventDefault();
    window.widget.saveSettings({ orbMode: false });
  } else if (settings.orbMode && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    changeOrbPool(event.key === "ArrowLeft" ? -1 : 1);
  }
});

setInterval(renderStatus, 1000);
Promise.all([window.widget.getSettings(), window.widget.getSnapshot(), window.widget.getWindowState()]).then(([savedSettings, initialSnapshot, initialWindowState]) => {
  settings = { ...settings, ...savedSettings };
  snapshot = initialSnapshot;
  modelUsage = initialSnapshot.data?.modelUsage || null;
  windowState = { ...windowState, ...initialWindowState };
  render();
});
