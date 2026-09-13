const $ = (id) => document.getElementById(id);

let snapshot = { ok: false, loading: true, data: null };
let windowState = { fullscreen: false };
let modelUsage = null;
let modelUsageRequest = 0;
let quotaTimeline = null;
let quotaTimelineRequest = 0;
let eventPage = null;
let eventPageRequest = 0;
let pricingCatalog = null;
let pricingCatalogRequest = 0;
let eventQueryDraft = "";
let eventSearchTimer = null;
let selectedCycleKey = null;
let selectedPricingId = null;
let renderFrame = null;
let chartTooltipContext = { series: [], metric: "total" };
let customTrendUsage = null;
let customTrendKey = null;
let customTrendError = "";
let customTrendRequest = 0;
let customTrendLoading = false;
let customTrendFormKey = null;
let trendChartScroll = { key: null, left: 0 };
let chartHoveredIndex = -1;
let chartTooltipFrame = null;
let chartTooltipVisible = false;
let chartTooltipPosition = { x: 0, y: 0, targetX: 0, targetY: 0 };
let smartPanelOpen = false;
const systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let liquidCanvases = [];
let previousPanelFocus = null;
function reducedMotion() { return window.WidgetMotion.reduced(settings.motionPreference, systemMotion.matches); }
const fullscreenMorph = window.FullscreenMorph.create(document);
let fullscreenRequestInFlight = false;
function stopLiquidAnimation() {
  if (liquidState.raf !== null) cancelAnimationFrame(liquidState.raf);
  liquidState.raf = null;
  liquidState.lastFrame = 0;
  liquidState.lastMotion = null;
}
const LIQUID_NODES = 25;
const liquidState = {
  configs: [],
  levels: new Map(),
  wave: Array(LIQUID_NODES).fill(0),
  velocity: Array(LIQUID_NODES).fill(0),
  particles: [],
  lastFrame: 0,
  lastMotion: null,
  raf: null,
};
let liquidPoolBaseline = new Map();
let pendingLiquidEffects = new Map();
let lastLiquidSnapshotAt = null;
let settings = {
  opacity: 0.96,
  compact: false,
  orbMode: false,
  orbPool: "cursor-models",
  orbDisplayMode: "quota",
  orbPoolShape: "sphere",
  orbPoolCombined: false,
  intervalMs: 30_000,
  activeTab: "overview",
  modelRange: "month1",
  modelPrecision: "coarse",
  modelView: "list",
  modelMetric: "total",
  trendRange: "day",
  trendCustomCount: 1,
  trendCustomUnit: "day",
  trendMetric: "total",
  trendBreakdown: false,
  trendSpeedBreakdown: false,
  trendModelBreakdown: false,
  dataSource: "all",
  quotaLevelPool: "cursor-models",
  eventSource: "all",
  pricingSource: "all",
  smartDock: false, // WIP: 智能贴边有严重 bug，入口已关闭。
  privacyMode: false,
  motionPreference: "system",
  openAtLogin: false,
  quotaAlerts: false, // WIP: 额度提醒有严重 bug，入口已关闭。
  alertThreshold: 20, // WIP: 提醒阈值有严重 bug，入口已关闭。
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayEmail(email) {
  if (!email) return "";
  return settings.privacyMode ? "****" : String(email);
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

function formatUntil(ts) {
  const remaining = Number(ts) - Date.now();
  if (!Number.isFinite(remaining)) return "等待同步";
  if (remaining <= 0) return "已到重置时间";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days}天${hours ? `${hours}小时` : ""}`;
  if (hours) return `${hours}小时${mins ? `${mins}分` : ""}`;
  return `${mins}分钟`;
}

function forecastText(insight) {
  if (!insight?.forecast || insight.forecast.status === "unknown") return "预测数据积累中";
  if (insight.forecast.status === "safe") return "按当前速度可撑到重置";
  if (Number(insight.remainingPercent) <= 0 || Number(insight.forecast.exhaustionAt) <= Date.now()) return "额度已耗尽，等待重置";
  return `预计 ${formatUntil(insight.forecast.exhaustionAt)}后耗尽`;
}

function forecastHtml(insight) {
  if (!insight) return "";
  const atRisk = insight.forecast?.status === "exhaust";
  return `<div class="quota-forecast ${atRisk ? "at-risk" : "safe"}"><i></i><span>${escapeHtml(forecastText(insight))}</span></div>`;
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
    if (value == null || value === "") return;
    const used = Number(value);
    if (!Number.isFinite(used)) return;
    pools.push({
      id,
      name,
      used: Math.min(100, Math.max(0, used)),
      remaining: remaining != null && Number.isFinite(Number(remaining)) ? Number(remaining) : Math.max(0, 100 - used),
      detail,
      precision,
      speedUsage: speedUsage || { normal: 0, fast: 0, unknown: 0, total: 0 },
      ...metadata,
    });
  };
  if (d.cursorModels) {
    addPool("cursor-models", "Cursor 模型池", d.cursorModels.percentUsed, d.cursorModels.percentRemaining, "Grok / Composer", 2, d.cursorModels.speedUsage, {
      capacityCents: window.LiquidPool.capacityOf(d.cursorModels),
      usedCents: Number(d.cursorModels.quotaEstimate?.usedCents) || null,
      capacityEstimated: d.cursorModels.quotaEstimate?.packageTotalSource !== "cursor-api",
    });
  }
  if (d.otherModels) {
    addPool("cursor-api", "Cursor API 池", d.otherModels.percentUsed, d.otherModels.percentRemaining, "Claude / GPT 等", 2, d.otherModels.speedUsage, {
      capacityCents: window.LiquidPool.capacityOf(d.otherModels),
      usedCents: Number(d.otherModels.quotaEstimate?.usedCents) || null,
      capacityEstimated: d.otherModels.quotaEstimate?.packageTotalSource !== "cursor-api",
    });
  }
  const addCodexPool = (quota, fallbackSlot) => {
    if (!quota) return;
    const used = quota.usedPercent != null && Number.isFinite(Number(quota.usedPercent)) ? Number(quota.usedPercent)
      : quota.percentRemaining != null ? 100 - Number(quota.percentRemaining) : null;
    const minutes = Number(quota.windowMinutes);
    const windowKey = Number.isFinite(minutes) && minutes > 0 ? String(minutes) : quota.slot || fallbackSlot;
    const reset = quota.expired
      ? "已重置 · 等待新请求同步"
      : formatQuotaReset(quota.resetsAt) || d.codex?.planName || "Codex";
    addPool(`codex-window-${windowKey}`, `Codex · ${quota.name || "额度窗口"}`, used, quota.percentRemaining, reset, 0, quota.speedUsage, {
      source: "codex",
      windowMinutes: Number.isFinite(minutes) ? minutes : null,
      quotaEstimate: quota.quotaEstimate || null,
      capacityCents: window.LiquidPool.capacityOf(quota),
      capacityEstimated: true,
    });
  };
  codexQuotaWindows(d.codex)
    .forEach((quota, index) => addCodexPool(quota, `slot-${index}`));
  return pools;
}

function usagePools(d) {
  const regular = quotaPools(d).filter((pool) => pool.source !== "codex");
  const thirdParty = regular.find((pool) => pool.id === "cursor-api");
  if (thirdParty) {
    thirdParty.name = "Cursor 三方模型池";
    thirdParty.capacityCents = Number(d?.otherModels?.quotaEstimate?.inferredTotalCents) || thirdParty.capacityCents;
    thirdParty.capacityEstimated = true;
  }
  const codex = window.LiquidPool.codexPool(
    codexQuotaWindows(d?.codex),
    d?.codex?.quotaEquivalent?.inferredTotalCents,
    d?.codex?.monthlyQuota,
    d?.codex?.quota?.shortLimit
  );
  if (codex) regular.push(codex);
  const scales = window.LiquidPool.sizeScales(regular);
  return regular.map((pool, index) => ({ ...pool, sizeScale: scales[index] }));
}

function orbPools(d, displayMode = settings.orbDisplayMode) {
  return displayMode === "pool" ? usagePools(d) : quotaPools(d);
}

function codexQuotaWindows(codex) {
  const windows = Array.isArray(codex?.quota?.windows) && codex.quota.windows.length
    ? codex.quota.windows
    : [codex?.quota?.primary, codex?.quota?.secondary].filter(Boolean);
  return windows
    .filter((quota) => !(codex?.quota?.shortLimit === "absent" && Number(quota.windowMinutes) === 300))
    .slice()
    .sort((a, b) => (Number(a.windowMinutes) || Number.MAX_SAFE_INTEGER) - (Number(b.windowMinutes) || Number.MAX_SAFE_INTEGER));
}

function quotaInsightsForDisplay(d) {
  const supplied = Array.isArray(d?.quotaInsights) ? d.quotaInsights : [];
  const byId = new Map(supplied.map((insight) => [String(insight.id), insight]));
  const actualCodexIds = new Set();
  codexQuotaWindows(d?.codex).forEach((quota, index, windows) => {
    const minutes = Number(quota.windowMinutes);
    const id = Number.isFinite(minutes) && minutes > 0 ? `codex-${minutes}` : `codex-${quota.slot || index}`;
    const existing = byId.get(id);
    const usedPercent = Number.isFinite(Number(quota.usedPercent))
      ? Number(quota.usedPercent)
      : Math.max(0, 100 - (Number(quota.percentRemaining) || 100));
    const label = minutes <= 360
      ? "Codex 5 小时"
      : minutes >= 6 * 24 * 60
        ? "Codex 每周"
        : `Codex ${quota.name || (windows.length > 1 ? `窗口 ${index + 1}` : "额度")}`;
    actualCodexIds.add(id);
    byId.set(id, {
      ...existing,
      id,
      label,
      usedPercent,
      remainingPercent: Number.isFinite(Number(quota.percentRemaining))
        ? Number(quota.percentRemaining)
        : Math.max(0, 100 - usedPercent),
      resetsAt: Number.isFinite(Number(quota.resetsAt)) ? Number(quota.resetsAt) : null,
      forecast: existing && !existing.pending
        ? existing.forecast
        : { status: "unknown", exhaustionAt: null },
      pending: false,
    });
  });
  return [...byId.values()]
    .filter((insight) => !(d?.codex?.quota?.shortLimit === "absent" && String(insight.id) === "codex-300"))
    .filter((insight) => !insight.pending || !actualCodexIds.has(String(insight.id)))
    .sort((a, b) => {
      const order = { "cursor-models": 0, "cursor-api": 1, cursor: 1, "codex-300": 2, "codex-10080": 3 };
      return (order[a.id] ?? 10) - (order[b.id] ?? 10);
    });
}

function selectedQuotaPool(pools) {
  return pools.find((pool) => pool.id === settings.orbPool)
    || (String(settings.orbPool).startsWith("codex-") ? pools.find((pool) => pool.source === "codex") : null)
    || pools[0];
}

function currentTankShape() {
  return window.LiquidPool.normalizeTankShape(settings.orbPoolShape);
}

function poolViewCombined() {
  return settings.orbDisplayMode === "pool" && Boolean(settings.orbPoolCombined);
}

function liquidCapacityText(pool) {
  if (!pool?.capacityCents) return "容量待估算";
  return `${pool.capacityEstimated ? "估算容量 " : "容量 "}${formatUsd(pool.capacityCents)}`;
}

function liquidPath(ctx, width, height, levelPercent, time, phase, amplitude) {
  const padding = 3;
  const usableHeight = height - padding * 2;
  const baseline = height - padding - usableHeight * window.LiquidPool.clamp(levelPercent) / 100;
  ctx.beginPath();
  for (let index = 0; index < LIQUID_NODES; index += 1) {
    const progress = index / (LIQUID_NODES - 1);
    const x = progress * width;
    const ambient = reducedMotion() ? 0 : Math.sin(progress * Math.PI * 3.2 + time * 0.0028 + phase) * amplitude;
    const y = baseline + liquidState.wave[index] * (0.62 + amplitude * 0.12) + ambient;
    if (!index) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
}

function liquidFill(ctx, width, height, level, time, options) {
  if (level <= 0.01) return;
  liquidPath(ctx, width, height, level, time, options.phase, options.amplitude);
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, options.top);
  gradient.addColorStop(1, options.bottom);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.save();
  liquidPath(ctx, width, height, level, time, options.phase, options.amplitude);
  ctx.clip();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#ffffff";
  const surface = height - 3 - (height - 6) * window.LiquidPool.clamp(level) / 100;
  ctx.fillRect(0, surface - 1, width, 1.3);
  ctx.restore();
}

function drawLiquidCanvas(canvas, config, levels, time) {
  if (!canvas || !config || !levels) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.save();
  window.LiquidPool.clipTankShape(ctx, rect.width, rect.height, currentTankShape(), 5);
  if (Array.isArray(config.layers) && config.layers.length) {
    const animated = levels.layers || {};
    for (let index = config.layers.length - 1; index >= 0; index -= 1) {
      const layer = config.layers[index];
      const level = animated[layer.id] ?? layer.level;
      if (!(level > 0.01)) continue;
      liquidFill(ctx, rect.width, rect.height, level, time, {
        top: layer.top, bottom: layer.bottom, phase: layer.phase, amplitude: layer.amplitude,
      });
    }
  } else {
    if (config.source === "codex") {
      liquidFill(ctx, rect.width, rect.height, levels.weeklyLevel, time, {
        top: "rgba(122, 137, 255, 0.92)", bottom: "rgba(58, 75, 176, 0.96)", phase: 1.8, amplitude: 0.75,
      });
    }
    liquidFill(ctx, rect.width, rect.height, levels.level, time, {
      top: "rgba(76, 226, 186, 0.94)", bottom: "rgba(22, 126, 132, 0.98)", phase: 0, amplitude: 1.05,
    });
  }
  const surfaceLevel = Array.isArray(config.layers) && config.layers.length
    ? (levels.layers?.[config.layers[config.layers.length - 1].id] ?? config.remaining ?? levels.level)
    : levels.level;
  const levelY = rect.height - 3 - (rect.height - 6) * window.LiquidPool.clamp(surfaceLevel) / 100;
  for (const particle of liquidState.particles) {
    ctx.globalAlpha = Math.max(0, particle.life);
    ctx.fillStyle = particle.weekly ? "#8b9aff" : "#7cf2ce";
    ctx.beginPath();
    ctx.arc(particle.x, levelY + particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLiquid(time) {
  const configs = new Map(liquidState.configs.map((config) => [config.id, config]));
  liquidCanvases.forEach((canvas) => {
    const config = configs.get(canvas.dataset.poolId);
    drawLiquidCanvas(canvas, config, liquidState.levels.get(config?.id), time);
  });
}

function maxLiquidLevel() {
  return Math.max(0, ...[...liquidState.levels.values()].map((levels) => Number(levels.level) || 0));
}

function stepLiquid(time) {
  liquidState.raf = null;
  if (!window.WidgetMotion.canAnimate({ visible: !document.hidden, orb: document.body.classList.contains("orb-mode"), mode: settings.orbDisplayMode, reduced: reducedMotion() })) return;
  // A real delta preserves speed on 120/144/240 Hz screens; clamp only long stalls.
  const dt = liquidState.lastFrame ? Math.min(0.034, Math.max(0, (time - liquidState.lastFrame) / 1000)) : 1 / 60;
  liquidState.lastFrame = time;
  for (const config of liquidState.configs) {
    const levels = liquidState.levels.get(config.id);
    if (!levels) continue;
    levels.level = window.WidgetMotion.approach(levels.level, config.remaining ?? 0, dt);
    levels.weeklyLevel = window.WidgetMotion.approach(levels.weeklyLevel, window.WidgetMotion.weeklyLevel(config), dt);
    if (Array.isArray(config.layers)) {
      levels.layers = levels.layers || {};
      for (const layer of config.layers) {
        const current = Number(levels.layers[layer.id]) || 0;
        levels.layers[layer.id] = window.WidgetMotion.approach(current, layer.level || 0, dt);
      }
    }
  }
  if (!reducedMotion()) {
    const nextVelocity = liquidState.velocity.slice();
    for (let index = 0; index < LIQUID_NODES; index += 1) {
      const current = liquidState.wave[index];
      const left = liquidState.wave[Math.max(0, index - 1)];
      const right = liquidState.wave[Math.min(LIQUID_NODES - 1, index + 1)];
      const acceleration = -34 * current + 105 * (left + right - current * 2);
      nextVelocity[index] = (liquidState.velocity[index] + acceleration * dt) * Math.pow(0.985, dt * 60);
    }
    for (let index = 0; index < LIQUID_NODES; index += 1) {
      liquidState.velocity[index] = nextVelocity[index];
      liquidState.wave[index] = Math.max(-10, Math.min(10, liquidState.wave[index] + nextVelocity[index] * dt));
    }
    for (const particle of liquidState.particles) {
      particle.vy += 42 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt * 1.55;
    }
    liquidState.particles = liquidState.particles.filter((particle) => particle.life > 0 && particle.y < 18);
  } else {
    liquidState.wave.fill(0);
    liquidState.velocity.fill(0);
    liquidState.particles = [];
  }
  drawLiquid(time);
  liquidState.raf = requestAnimationFrame(stepLiquid);
}

function ensureLiquidAnimation(configs) {
  liquidState.configs = Array.isArray(configs) ? configs : [configs].filter(Boolean);
  const ids = new Set(liquidState.configs.map((config) => config.id));
  for (const id of liquidState.levels.keys()) if (!ids.has(id)) liquidState.levels.delete(id);
  for (const config of liquidState.configs) {
    if (!liquidState.levels.has(config.id)) {
      liquidState.levels.set(config.id, { level: 0, weeklyLevel: 0, layers: {} });
    }
    const levels = liquidState.levels.get(config.id);
    if (Array.isArray(config.layers) && !levels.layers) levels.layers = {};
  }
  if (document.hidden) { stopLiquidAnimation(); return; }
  if (reducedMotion()) {
    stopLiquidAnimation();
    liquidState.wave.fill(0);
    liquidState.velocity.fill(0);
    liquidState.particles = [];
    for (const config of liquidState.configs) {
      liquidState.levels.set(config.id, { level: config.remaining ?? 0, weeklyLevel: window.WidgetMotion.weeklyLevel(config),
        layers: Object.fromEntries((config.layers || []).map((layer) => [layer.id, layer.level])) });
    }
    drawLiquid(0);
    return;
  }
  if (liquidState.raf === null) {
    liquidState.lastFrame = 0;
    liquidState.raf = requestAnimationFrame(stepLiquid);
  }
}

function splashLiquid(strength, direction = 0) {
  const tank = document.querySelector(".usage-pool-tank");
  const width = tank?.getBoundingClientRect().width || 112;
  const amount = Math.min(6, Math.max(2, Math.round(strength * 3)));
  for (let index = 0; index < amount; index += 1) {
    liquidState.particles.push({
      x: width / 2 + direction * width * 0.18 + (Math.random() - 0.5) * width * 0.16,
      y: -1,
      vx: direction * 12 + (Math.random() - 0.5) * 24,
      vy: -18 - Math.random() * 25 * strength,
      radius: 0.9 + Math.random() * 1.4,
      life: 0.75 + Math.random() * 0.25,
      weekly: Math.random() > 0.55,
    });
  }
}

function triggerLiquidRefresh(effect) {
  if (reducedMotion() || document.hidden) return;
  if (!(Number(effect?.amountCents) > 0)) return;
  const cards = [...document.querySelectorAll("[data-usage-pool]")];
  const card = cards.find((element) => element.dataset.usagePool === effect?.id)
    || (poolViewCombined() ? cards.find((element) => element.dataset.usagePool === "usage-combined") : null);
  const damage = card?.querySelector(".orb-damage");
  const drain = card?.querySelector(".orb-drain");
  if (!damage || !drain || !effect) return;
  const parts = window.LiquidPool.damageParts(effect.amountCents);
  damage.innerHTML = `<span>${parts.major}</span><small>${parts.minor}</small>`;
  damage.setAttribute("aria-label", `本次用量${parts.major}${parts.minor}`);
  const strength = Math.min(2, 0.65 + effect.levelDelta * 0.12 + Math.sqrt(effect.amountCents || 0) * 0.035);
  const durationMs = window.LiquidPool.refreshEffectDuration(effect.amountCents, settings.intervalMs);
  drain.style.setProperty("--drain-strength", strength.toFixed(2));
  drain.style.setProperty("--drain-duration", `${durationMs}ms`);
  damage.classList.remove("active");
  drain.classList.remove("active");
  void damage.offsetWidth;
  damage.classList.add("active");
  drain.classList.add("active");
  for (let index = 0; index < LIQUID_NODES; index += 1) {
    const progress = index / (LIQUID_NODES - 1);
    liquidState.velocity[index] = Math.max(-90, Math.min(90,
      liquidState.velocity[index] + Math.sin(progress * Math.PI * 2.4) * 15 * strength
    ));
  }
  if (maxLiquidLevel() > 3) splashLiquid(Math.min(1.25, strength * 0.7), 1);
}

function recordLiquidSnapshot(next, animate = true) {
  if (!next?.data || next.loading) return;
  const snapshotAt = Number(next.fetchedAt || next.data.fetchedAt) || Date.now();
  if (lastLiquidSnapshotAt != null && snapshotAt <= lastLiquidSnapshotAt) return;
  const pools = usagePools(next.data);
  const nextBaseline = new Map(pools.map((pool) => [pool.id, pool]));
  if (animate && liquidPoolBaseline.size && settings.orbMode && settings.orbDisplayMode === "pool") {
    for (const pool of pools) {
      const previous = liquidPoolBaseline.get(pool.id);
      const spend = window.LiquidPool.refreshSpend(previous, pool);
      if (!spend) continue;
      pendingLiquidEffects.set(pool.id, {
        id: pool.id,
        amountCents: spend.amountCents,
        levelDelta: spend.levelDelta,
        at: snapshotAt,
      });
    }
  }
  liquidPoolBaseline = nextBaseline;
  lastLiquidSnapshotAt = snapshotAt;
}

function handleWindowMotion(sample) {
  if (reducedMotion() || document.hidden) return;
  if (!sample || settings.orbDisplayMode !== "pool" || !settings.orbMode) return;
  const previous = liquidState.lastMotion;
  const current = { x: Number(sample.x), y: Number(sample.y), at: Number(sample.at), vx: 0, vy: 0 };
  if (!previous || !Number.isFinite(current.x + current.y + current.at)) {
    liquidState.lastMotion = current;
    return;
  }
  const dt = Math.max(8, Math.min(80, current.at - previous.at));
  current.vx = sample.settled ? 0 : (current.x - previous.x) / dt;
  current.vy = sample.settled ? 0 : (current.y - previous.y) / dt;
  const deltaVx = Math.max(-3, Math.min(3, current.vx - previous.vx));
  const deltaVy = Math.max(-3, Math.min(3, current.vy - previous.vy));
  for (let index = 0; index < LIQUID_NODES; index += 1) {
    const side = index / (LIQUID_NODES - 1) - 0.5;
    liquidState.velocity[index] += -deltaVx * side * 155 - deltaVy * Math.cos(side * Math.PI) * 20;
  }
  const impact = Math.hypot(deltaVx, deltaVy);
  if (impact > 0.42 && maxLiquidLevel() > 3) splashLiquid(Math.min(1.8, impact), Math.sign(-deltaVx));
  liquidState.lastMotion = current;
}

function renderOrbResets(d) {
  const insights = quotaInsightsForDisplay(d);
  const compact = settings.orbDisplayMode === "pool";
  const html = insights.length
    ? insights.map((insight) => {
      const atRisk = insight.forecast?.status === "exhaust";
      const detail = compact
        ? ""
        : `<small>${escapeHtml(formatQuotaReset(insight.resetsAt) || "等待重置时间")} · ${escapeHtml(forecastText(insight))}</small>`;
      const resetDetail = `${formatQuotaReset(insight.resetsAt) || "等待重置时间"} · ${forecastText(insight)}`;
      return `<div class="orb-reset-row ${atRisk ? "at-risk" : "safe"}" title="${escapeHtml(resetDetail)}">
        <span><b>${escapeHtml(insight.label)}</b>${detail}</span>
        <em class="orb-reset-time">${escapeHtml(formatUntil(insight.resetsAt))}</em>
      </div>`;
    }).join("")
    : `<div class="orb-reset-empty">正在同步全部额度重置时间…</div>`;
  if ($("orbResetList").innerHTML !== html) $("orbResetList").innerHTML = html;
}

function renderOrbShapeSwitch() {
  const root = $("orbShapeSwitch");
  if (!root) return;
  const shape = currentTankShape();
  if (root.dataset.ready !== "1") {
    root.dataset.ready = "1";
    root.innerHTML = window.LiquidPool.TANK_SHAPES.map((item) => (
      `<button type="button" data-orb-shape="${escapeHtml(item.id)}" title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}"><i></i></button>`
    )).join("");
  }
  root.querySelectorAll("[data-orb-shape]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orbShape === shape);
    button.setAttribute("aria-pressed", String(button.dataset.orbShape === shape));
  });
}

function renderUsagePoolGallery(pools) {
  const gallery = $("orbPoolGallery");
  const shape = currentTankShape();
  const combined = poolViewCombined();
  const tank = combined ? window.LiquidPool.combinedTank(pools) : null;
  const signature = JSON.stringify({
    combined,
    shape,
    pools: (combined ? [tank] : pools).map((pool) => [
      pool.id, pool.remaining, pool.shortRemaining, pool.weeklyRemaining, pool.weeklyOnlyRemaining,
      pool.capacityCents, pool.shortCapacityCents, pool.sizeScale,
      pool.shortLimit, pool.monthly?.currentEnd, pool.monthly?.futureResetCount, pool.monthly?.unknownCents, pool.monthly?.immediateKnown,
      pool.monthly?.cycles?.map((cycle) => [cycle.startAt, cycle.endAt, cycle.resetAt, cycle.planType, cycle.interrupted, cycle.knownUsedCents, cycle.unpricedCount, cycle.previousMonthUsedCents, cycle.previousMonthUsageKnown]),
      pool.layers?.map((layer) => [layer.id, layer.name, layer.level, layer.remainingCents]),
    ]),
  });
  if (gallery.dataset.signature !== signature) {
    gallery.dataset.signature = signature;
    gallery.innerHTML = combined
      ? renderCombinedPoolCard(tank, shape)
      : pools.map((pool) => renderUsagePoolCard(pool, shape)).join("");
    liquidCanvases = [...gallery.querySelectorAll(".usage-liquid")];
    gallery.querySelectorAll(".usage-pool-tank").forEach((element) => {
      const scale = Number(element.dataset.tankScale);
      if (scale > 0) element.style.setProperty("--tank-scale", String(scale));
    });
  }
}

function renderUsagePoolCard(pool, shape) {
  const displayedRemaining = pool.monthly ? pool.monthlyRemaining : pool.source === "codex" ? pool.shortRemaining : pool.remaining;
  const pct = pool.precision === 2 ? formatCursorPct(displayedRemaining) : formatPct(displayedRemaining);
  const scale = Number(pool.sizeScale) > 0 ? Number(pool.sizeScale) : 1;
  const month = pool.monthly;
  const currentLabel = month?.shortLimit === "absent" ? "本周可用" : month?.shortLimit === "present" ? "5h 可用" : "当前可用";
  const currentCapacity = month?.shortLimit === "absent" ? month.weeklyCapacityCents : month?.shortCapacityCents;
  const currentPercent = month?.immediateKnown
    ? month.immediateCents === 0 ? 0 : currentCapacity > 0 ? window.LiquidPool.clamp(month.immediateCents / currentCapacity * 100) : null
    : null;
  const currentValue = currentPercent == null ? "待确认" : month.shortLimit === "absent"
    ? formatPct(pool.weeklyRemaining) : `${currentPercent > 0 ? "≈" : ""}${formatCursorPct(currentPercent)}`;
  const monthlyHistory = (month?.cycles || []).filter((cycle) => cycle.state === "completed").map((cycle) => {
    const date = (at) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `${date(cycle.startAt)}–${date(cycle.endAt)}${cycle.planType ? ` · ${cycle.planType === "prolite" ? "Pro 5×" : cycle.planType}` : ""}${cycle.interrupted ? "（提前重置）" : ""}${cycle.startAt < month.startAt ? "（本月部分）" : ""}：${cycle.usedCents == null
      ? `已知消耗 ≈${formatUsd(cycle.knownUsedCents || 0)}；${cycle.unpricedCount ? `最后额度快照之后仍有 ${cycle.unpricedCount} 条记录未计价` : "缺少历史依据"}，其余无法区分已用和未用`
      : `已用 ≈${formatUsd(cycle.usedCents)}，过期未用 ≈${formatUsd(cycle.unusedCents)}`}`;
  }).join("\n");
  const carryNote = month?.cycles?.some((cycle) => cycle.startAt < month.startAt)
    ? `\n月初跨月周已扣除上月已知消耗 ≈${formatUsd(month.previousMonthUsedCents || 0)}${month.previousMonthUsageKnown ? "。" : "；上月记录不完整，扣减仍可能不足。"}` : "";
  const resetNote = month?.cycles?.some((cycle) => cycle.interrupted)
    ? "\n已按实际提前重置分段；旧周期容量按该周期记录估算，未沿用新套餐容量。" : "";
  const monthlyNote = month ? `自然月，计入 ${month.cycleCount} 个相交周周期；后续 ${month.futureResetCount} 次周重置。${carryNote}${resetNote}\n当前可用：${month.immediateKnown ? formatUsd(month.immediateCents) : "待估算"}；本周剩余 ${formatPct(pool.weeklyRemaining)}。${month.shortLimit === "absent" ? "当前服务端未设置 5h 窗口，按周额度判断可用量。" : month.shortLimit === "present" ? `5h 剩余 ${formatCursorPct(pool.shortRemaining)}。` : "5h 限制信息尚不完整。"}\n月总量和历史用量均为估算。紫色为过期或提前重置时未用；灰色为缺少可覆盖的额度快照或后续记录未计价，无法区分已用和未用，不计入可用额度。${monthlyHistory ? `\n${monthlyHistory}` : ""}` : "";
  const codexLegend = month
    ? ""
    : pool.source === "codex" && pool.shortLimit !== "absent"
    ? `<div class="usage-pool-legend"><span><i class="immediate"></i>5 小时可用 ${escapeHtml(formatCursorPct(pool.shortRemaining))}</span><span><i class="weekly"></i>仅周池可用 ${escapeHtml(formatPct(pool.weeklyOnlyRemaining))}</span></div>`
    : "";
  const capacity = month
    ? `${new Date(month.startAt).getMonth() + 1}月总容量 ≈${formatUsd(month.capacityCents)} ⓘ`
    : pool.source === "codex" && pool.shortLimit !== "absent"
    ? `7天 ${formatUsd(pool.capacityCents)} · 5小时 ${formatUsd(pool.shortCapacityCents)}`
    : liquidCapacityText(pool);
  return `<article class="usage-pool-card${month ? " has-monthly" : ""}" data-usage-pool="${escapeHtml(pool.id)}">
    <div class="usage-pool-slot">
      <div class="usage-pool-tank${pool.source === "codex" ? " codex" : ""}" data-tank-shape="${escapeHtml(shape)}" data-tank-scale="${scale.toFixed(4)}" role="meter" aria-label="${escapeHtml(pool.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(displayedRemaining).toFixed(2)}">
        <span class="usage-pool-glass" aria-hidden="true"></span>
        <canvas class="usage-liquid" data-pool-id="${escapeHtml(pool.id)}" aria-hidden="true"></canvas>
        <i class="orb-drain" aria-hidden="true"></i>
        <output class="orb-damage" aria-live="polite"></output>
      </div>
    </div>
    <div class="usage-pool-info">
      <b>${escapeHtml(pool.name)}</b>
      <strong>${escapeHtml(month ? formatCursorPct(pool.monthlyRemaining) : pct)}<small>${month ? " 月内待用" : pool.source === "codex" ? pool.shortLimit === "absent" ? " 本周可用" : " 5小时可用" : " 可用"}</small></strong>
      ${month ? `<span class="pool-current-availability" title="${escapeHtml(month.shortLimit === "absent" ? "当前周周期剩余可用额度占本周总容量的比例" : "当前可用额度占 5h 总容量的比例，同时受本周剩余额度限制；不含未来周期")}"><i aria-hidden="true"></i><span>${currentLabel}</span><b>${escapeHtml(currentValue)}</b></span>` : ""}
      <span class="pool-detail-hint" title="${escapeHtml(monthlyNote || capacity)}">${escapeHtml(capacity)}</span>
      ${codexLegend}
    </div>
  </article>`;
}

function renderCombinedPoolCard(tank, shape) {
  const pct = formatCursorPct(tank.remaining);
  const legend = `<div class="usage-pool-legend combined-legend">${tank.layers.map((layer) => {
    const amount = formatUsd(layer.remainingCents);
    const names = { "cursor-models": "模型", "cursor-api": "三方", "codex-future": "后续周", "codex-weekly": "本周", "codex-immediate": "可用", "codex-expired": "过期未用", "codex-unknown": "记录不足" };
    return `<span class="pool-detail-hint" title="${escapeHtml(`${layer.name} · ${formatPct(layer.share)} · ${amount}`)}"><i data-tone="${escapeHtml(layer.tone)}"></i>${escapeHtml(names[layer.tone] || layer.name)}</span>`;
  }).join("")}</div>`;
  return `<article class="usage-pool-card combined" data-usage-pool="${escapeHtml(tank.id)}">
    <div class="usage-pool-slot">
      <div class="usage-pool-tank" data-tank-shape="${escapeHtml(shape)}" data-tank-scale="1" role="meter" aria-label="${escapeHtml(tank.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(tank.remaining).toFixed(2)}">
        <span class="usage-pool-glass" aria-hidden="true"></span>
        <canvas class="usage-liquid" data-pool-id="${escapeHtml(tank.id)}" aria-hidden="true"></canvas>
        <i class="orb-drain" aria-hidden="true"></i>
        <output class="orb-damage" aria-live="polite"></output>
      </div>
    </div>
    <div class="usage-pool-info">
      <b>${escapeHtml(tank.name)}</b>
      <strong>${escapeHtml(pct)}<small>${tank.hasMonthly ? " 合计待用" : " 合计可用"}</small></strong>
      <span>${escapeHtml(liquidCapacityText(tank))}</span>
      ${legend}
    </div>
  </article>`;
}

function renderOrb(d) {
  if (!settings.orbMode || windowState.fullscreen) { stopLiquidAnimation(); return; }
  const displayMode = ["quota", "speed", "pool"].includes(settings.orbDisplayMode) ? settings.orbDisplayMode : "quota";
  if (displayMode !== "pool") stopLiquidAnimation();
  const pools = orbPools(d, displayMode);
  const poolCaption = document.querySelector(".orb-footer-pool");
  if (poolCaption) poolCaption.textContent = pools.some((pool) => pool.monthly)
    ? "青色可用 · 蓝色待重置 · 紫色过期未用" : "容器大小表示容量 · 水位表示可用";
  const selected = selectedQuotaPool(pools);
  const ring = $("orbRing");
  renderOrbResets(d);
  renderOrbShapeSwitch();
  document.body.dataset.tankShape = currentTankShape();
  const combinedBtn = $("orbCombinedBtn");
  if (combinedBtn) {
    combinedBtn.classList.toggle("active", poolViewCombined());
    combinedBtn.setAttribute("aria-pressed", poolViewCombined() ? "true" : "false");
  }
  document.querySelectorAll("[data-orb-display]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orbDisplay === displayMode);
    button.setAttribute("aria-pressed", String(button.dataset.orbDisplay === displayMode));
  });
  $("orbRefreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
  $("orbPrevBtn").disabled = displayMode === "pool" || pools.length < 2;
  $("orbNextBtn").disabled = displayMode === "pool" || pools.length < 2;
  if (displayMode === "pool") renderUsagePoolGallery(pools);
  if (!selected) {
    stopLiquidAnimation();
    pendingLiquidEffects.clear();
    liquidState.configs = [];
    liquidState.levels.clear();
    const canvas = $("orbLiquid");
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    ring.style.setProperty("--orb-used", "0");
    ring.className = `orb-ring ${displayMode}-mode`;
    ring.removeAttribute("aria-valuenow");
    $("orbPercent").textContent = "—";
    $("orbValueLabel").textContent = displayMode === "pool" ? "可用" : "已用";
    $("orbCapacity").textContent = "";
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
  const normalEnd = unknownPoints + normalPoints;
  const fastEnd = Math.min(selected.used, normalEnd + fastPoints);
  ring.style.setProperty("--pool-scale", String(selected.sizeScale || 1));
  ring.style.setProperty("--pool-size", `${(126 * (selected.sizeScale || 1)).toFixed(1)}px`);
  ring.style.setProperty("--orb-used", selected.used.toFixed(2));
  ring.style.setProperty("--orb-unknown-end", `${unknownPoints.toFixed(3)}%`);
  ring.style.setProperty("--orb-normal-end", `${normalEnd.toFixed(3)}%`);
  ring.style.setProperty("--orb-fast-end", `${fastEnd.toFixed(3)}%`);
  ring.style.setProperty("--orb-used-end", `${selected.used.toFixed(3)}%`);
  ring.className = `orb-ring ${displayMode}-mode${displayMode === "speed" && fastPoints > 0.001 ? " has-fast" : ""}${displayMode === "pool" && selected.source === "codex" ? " codex-pool" : ""}`;
  const meterValue = displayMode === "pool" ? selected.remaining : selected.used;
  ring.setAttribute("aria-valuenow", Number(meterValue).toFixed(1));
  ring.setAttribute("aria-valuetext", `${selected.name}${displayMode === "pool" ? "可用" : "已用"}${formatPct(meterValue)}`);
  $("orbPercent").textContent = pct(meterValue);
  $("orbValueLabel").textContent = displayMode === "pool" ? "可用" : "已用";
  $("orbCapacity").textContent = displayMode === "pool" ? liquidCapacityText(selected) : "";
  $("orbPoolName").textContent = selected.name;
  $("orbPoolDetail").textContent = displayMode === "speed"
    ? `${unknownPoints > 0.01 ? `未知 ${pct(unknownPoints)} · ` : ""}普通 ${pct(normalPoints)} · Fast ${pct(fastPoints)}`
    : displayMode === "pool"
      ? selected.source === "codex"
        ? `青色 5 小时可用 ${pct(selected.remaining)} · 蓝色仅周池 ${pct(selected.weeklyOnlyRemaining)}`
        : `水位 ${pct(selected.remaining)} · ${liquidCapacityText(selected)}`
      : `剩余 ${pct(selected.remaining)} · ${selected.detail}`;
  if (displayMode === "pool") {
    const liquidConfigs = poolViewCombined() ? [window.LiquidPool.combinedTank(pools)] : pools;
    ensureLiquidAnimation(liquidConfigs);
    if (poolViewCombined()) {
      const merged = [...pendingLiquidEffects.values()].reduce((total, effect) => ({
        id: "usage-combined",
        amountCents: total.amountCents + effect.amountCents,
        levelDelta: total.levelDelta + effect.levelDelta,
      }), { amountCents: 0, levelDelta: 0 });
      if (merged.amountCents > 0) triggerLiquidRefresh(merged);
    } else {
      for (const effect of pendingLiquidEffects.values()) triggerLiquidRefresh(effect);
    }
    pendingLiquidEffects.clear();
  }
}

function changeOrbPool(direction) {
  const pools = orbPools(snapshot.data);
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
  const insights = quotaInsightsForDisplay(snapshot.data);
  const pending = insights.filter((item) => item.pending && String(item.id).startsWith("codex-"));
  if (!windows.length && !pending.length) return `<div class="empty-state codex-window-empty">当前套餐额度窗口暂不可用</div>`;
  const windowRows = windows.map((quota) => {
    const used = Math.min(100, Math.max(0, Number(quota.usedPercent) || 0));
    const remaining = Number.isFinite(Number(quota.percentRemaining)) ? Number(quota.percentRemaining) : Math.max(0, 100 - used);
    const name = quota.name || (quota.windowMinutes ? `${quota.windowMinutes} 分钟额度` : "额度窗口");
    const reset = quota.expired
      ? "已重置 · 等待新请求同步"
      : formatQuotaReset(quota.resetsAt) || "等待重置时间";
    const insight = insights.find((item) => item.id === `codex-${Number(quota.windowMinutes)}`);
    return `<section class="codex-window-row" aria-label="${escapeHtml(name)}">
      <div class="codex-window-head">
        <span><b>${escapeHtml(name)}</b><small>${escapeHtml(reset)}</small></span>
        <strong class="${toneClass(used)}">${formatPct(remaining)} <em>剩余</em></strong>
      </div>
      <progress class="quota-progress codex" max="100" value="${used}" aria-label="${escapeHtml(name)}已用比例">${used}%</progress>
      <div class="codex-window-stats"><span>已用 <b>${formatPct(used)}</b></span><span>剩余 <b>${formatPct(remaining)}</b></span></div>
      ${forecastHtml(insight)}
    </section>`;
  }).join("");
  const pendingRows = pending.map((insight) => `<section class="codex-window-row pending" aria-label="${escapeHtml(insight.label)}等待同步">
    <div class="codex-window-head">
      <span><b>${escapeHtml(insight.label.replace(/^Codex\s*/, ""))}</b><small>暂未包含在最新响应中</small></span>
      <strong>— <em>剩余</em></strong>
    </div>
    <div class="quota-forecast"><i></i><span>保留窗口 · 等待下次响应同步</span></div>
  </section>`).join("");
  return `<div class="codex-window-list">${windowRows}${pendingRows}</div>`;
}

function renderOverview(d) {
  const names = { "cursor-models": "Cursor 模型", "cursor-api": "三方模型", "codex-window-300": "Codex 5h", "codex-window-10080": "Codex 7d" };
  $("quotaGlance").innerHTML = quotaPools(d).map((pool) => {
    const target = pool.source === "codex" ? "codexPool" : pool.id === "cursor-models" ? "cursorPool" : "otherPool";
    return `<button type="button" data-quota-target="${target}" title="${escapeHtml(pool.name)} · 点击查看详情"><span>${escapeHtml(names[pool.id] || pool.name)}</span><b class="${toneClass(pool.used)}">${pool.precision === 2 ? formatCursorPct(pool.remaining) : formatPct(pool.remaining)}</b><small>剩余</small></button>`;
  }).join("");
  const combined = d.combined || {};
  const codex = d.codex;
  const cursorIncluded = d.otherModels?.includedCents || {};
  const codexCost = codex?.apiEquivalent || {};
  const cursorPoolCost = d.cursorModels?.apiEquivalent || {};
  const cursorPoolQuota = d.cursorModels?.quotaEstimate || {};
  const otherPoolCost = d.otherModels?.apiEquivalent || {};
  const otherPoolQuota = d.otherModels?.quotaEstimate || {};
  const cursorModelInsight = (d.quotaInsights || []).find((item) => item.id === "cursor-models")
    || (d.quotaInsights || []).find((item) => item.id === "cursor");
  const otherModelInsight = (d.quotaInsights || []).find((item) => item.id === "cursor-api")
    || (d.quotaInsights || []).find((item) => item.id === "cursor");
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
       ${forecastHtml(cursorModelInsight)}
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
      ${forecastHtml(otherModelInsight)}
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
    ? `<div class="recent-icon">↗</div><div class="recent-copy"><span>最近一次调用 · ${last.source === "codex" ? "Codex" : "Cursor"}</span><b>${escapeHtml(window.ModelDisplay.format(last))}</b><small>总 ${formatTokens(lastTotal)} Token · 有效 ${formatTokens(lastEffective)} · 写缓存 ${formatTokens(last.tokens?.cacheWrite)} / ${formatUsd(last.cacheWriteCostCents)} · 读缓存 ${formatTokens(last.tokens?.cacheRead)} / ${formatUsd(last.cacheReadCostCents)} · ${lastCost} · ${timeAgo(last.at)}</small></div>${recentDonutHtml(last)}`
    : `<div class="empty-state">本周期还没有可显示的用量事件</div>`;
}

function recentDonutHtml(last) {
  const tokens = last?.tokens || {};
  const parts = [
    { key: "input", value: Number(tokens.input) || 0, className: "input" },
    { key: "cacheWrite", value: Number(tokens.cacheWrite) || 0, className: "cache-write" },
    { key: "cacheRead", value: Number(tokens.cacheRead) || 0, className: "cache-read" },
    { key: "output", value: Number(tokens.output) || 0, className: "output" },
  ];
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = parts.map((part) => {
    const length = total > 0 ? (part.value / total) * circumference : 0;
    const circle = `<circle class="recent-donut-ring ${part.className}" cx="21" cy="21" r="${radius}" stroke-dasharray="${length.toFixed(2)} ${Math.max(0, circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
    offset += length;
    return circle;
  }).join("");
  const cost = last?.equivalentCostCents == null ? "—" : formatUsd(last.equivalentCostCents);
  return `<div class="recent-donut" aria-label="最近一次 Token 构成"><svg viewBox="0 0 42 42" role="img"><circle class="recent-donut-ring track" cx="21" cy="21" r="${radius}"></circle>${rings}</svg><div class="recent-donut-core">${escapeHtml(cost)}</div></div>`;
}

const precisionNotes = {
  coarse: "只按基础模型合并，Fast 与 thinking effort 均不拆分。",
  speed: "同一模型拆分标准 / Fast，thinking effort 仍合并。",
  exact: "Fast 与每一种 thinking effort 都作为独立型号统计。",
};

function renderModels(d) {
  const precision = settings.modelPrecision || "coarse";
  const source = settings.dataSource || "all";
  const donut = settings.modelView === "donut";
  $("modelList").hidden = donut;
  $("modelDonutPanel").hidden = !donut;
  document.querySelectorAll("[data-model-view]").forEach((button) => {
    const selected = (button.dataset.modelView === "donut") === donut;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const activeUsage = modelUsage?.key === settings.modelRange ? modelUsage : null;
  const view = activeUsage?.sources?.[source] || activeUsage?.sources?.all;
  if (!view) {
    const option = $("modelRangeSelect").selectedOptions[0];
    $("modelCount").textContent = "读取中";
    $("modelSubtitle").textContent = `${option?.textContent || "所选范围"} · 正在聚合持久化历史`;
    $("modelList").innerHTML = `<div class="empty-state">正在计算模型用量…</div>`;
    $("modelDonutContent").innerHTML = `<div class="empty-state">正在计算模型用量…</div>`;
    $("modelDonutNote").textContent = "";
    return;
  }
  const rows = view.modelBreakdowns?.[precision] || [];
  $("modelCount").textContent = `${formatInteger(view.eventCount)} 次`;
  $("modelSubtitle").textContent = `${view.label || "全部"} · ${view.periodLabel || "当前周期"} · 按总 Token（含缓存）排序`;
  const unknownSpeed = source !== "cursor" ? donut ? " 环状图中 Codex 速度未知的请求并入非 Fast；原始记录不变。" : " Codex 优先持久化服务端响应 service_tier；抓不到响应时回退到本地请求记录，旧记录可能显示速度未知。" : "";
  $("precisionNote").textContent = precisionNotes[precision] + unknownSpeed;
  document.querySelectorAll("[data-precision]").forEach((button) => {
    button.classList.toggle("active", button.dataset.precision === precision);
  });
  document.querySelectorAll("[data-source]").forEach((button) => {
    button.classList.toggle("active", button.dataset.source === source);
  });
  if (donut) { renderModelDonut(activeUsage, view); return; }
  if (!rows.length) {
    $("modelList").innerHTML = `<div class="empty-state">暂无模型明细</div>`;
    return;
  }
  const max = Math.max(1, ...rows.map((row) => Number(row.total) || 0));
  $("modelList").innerHTML = rows
    .map((row, index) => {
      const modelLabel = window.ModelDisplay.format(row, { precision });
      return `
      <article class="model-row">
        <div class="model-rank">${String(index + 1).padStart(2, "0")}</div>
        <div class="model-main">
          <div class="model-title"><b title="${escapeHtml(modelLabel)}">${escapeHtml(modelLabel)}</b><span>${formatTokens(row.total)} 总 Token</span></div>
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
      </article>`;
    })
    .join("");
}

let modelDonutState = null;
function modelColor(key) {
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 65% 68%)`;
}
function renderModelDonut(usage, view) {
  const metric = ["total", "effective", "costCents"].includes(settings.modelMetric) ? settings.modelMetric : "total";
  const label = metric === "costCents" ? "美元等效" : metric === "effective" ? "有效 Token" : "总 Token";
  const format = metric === "costCents" ? formatUsd : formatTokens;
  const result = window.UsageCharts.modelSlices(usage.sources, { source: settings.dataSource, precision: settings.modelPrecision, metric });
  modelDonutState = { ...result, metric, label };
  $("modelMetricSelect").value = metric;
  $("modelSubtitle").textContent = `${view.label || "全部"} · ${view.periodLabel || "当前周期"} · ${label}占比`;
  const coverage = Number(view.costCoveragePercent);
  $("modelDonutNote").textContent = `占比按${label}计算，所有模型均保留；悬停或聚焦图例查看详情。${metric === "costCents" ? ` 仅统计已知价格，计价覆盖 ${Number.isFinite(coverage) ? formatPct(coverage) : "未知"}；未计价用量不代表免费。` : ""}`;
  if (!result.rows.length) {
    $("modelDonutContent").innerHTML = `<div class="empty-state">所选范围暂无模型用量</div>`;
    return;
  }
  const circles = result.rows.map((row, index) => row.percent > 0
    ? `<circle class="model-donut-slice" data-donut-index="${index}" cx="100" cy="100" r="76" pathLength="100" fill="none" stroke="${modelColor(row.key)}" stroke-width="24" stroke-dasharray="${row.percent} ${100 - row.percent}" stroke-dashoffset="${-row.offset}" transform="rotate(-90 100 100)"><title>${escapeHtml(row.label)} · ${escapeHtml(format(row.value))} · ${row.percent.toFixed(2)}%</title></circle>` : "").join("");
  const legend = result.rows.map((row, index) => `<button type="button" class="model-donut-legend-row" data-donut-index="${index}"><svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${modelColor(row.key)}"/></svg><span><b>${escapeHtml(row.label)}</b><small>${formatInteger(row.count)} 次 · ${format(row.value)}</small></span><strong>${row.percent.toFixed(2)}%</strong></button>`).join("");
  $("modelDonutContent").innerHTML = `<div class="model-donut-visual"><svg class="model-donut-svg" viewBox="0 0 200 200" role="img" aria-label="${label}按模型分布"><circle cx="100" cy="100" r="76" fill="none" stroke="var(--line)" stroke-width="24"/>${circles}</svg><div class="model-donut-center"><span id="modelDonutLabel">${label}合计</span><strong id="modelDonutValue">${format(result.total)}</strong><small id="modelDonutShare">${result.total > 0 ? `${result.rows.length} 个分组` : "暂无可计算占比的用量"}</small></div></div><div class="model-donut-legend">${legend}</div>`;
}
function highlightModelDonut(index = -1) {
  if (!modelDonutState || !$("modelDonutValue")) return;
  const row = modelDonutState.rows[index];
  const format = modelDonutState.metric === "costCents" ? formatUsd : formatTokens;
  $("modelDonutContent").querySelectorAll("[data-donut-index]").forEach((element) => {
    element.classList.toggle("muted", Boolean(row) && Number(element.dataset.donutIndex) !== index);
    element.classList.toggle("selected", Boolean(row) && Number(element.dataset.donutIndex) === index);
  });
  $("modelDonutLabel").textContent = row?.label || `${modelDonutState.label}合计`;
  $("modelDonutValue").textContent = format(row?.value ?? modelDonutState.total);
  $("modelDonutShare").textContent = row ? `${row.percent.toFixed(2)}% · ${formatInteger(row.count)} 次` : `${modelDonutState.rows.length} 个分组`;
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
    $("modelDonutContent").innerHTML = $("modelList").innerHTML;
  }
}

function formatMetric(value, metric) {
  return metric === "equivalentCostCents" ? formatUsd(value, true) : formatTokens(value);
}

function axisValue(value, metric) {
  if (metric === "equivalentCostCents") return formatUsd(value, true);
  return formatTokens(value, 0);
}

function compositionSegmentDefinitions(metric) {
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

function speedLaneDefinitions() {
  return [
    { id: "normal", label: "非 Fast", className: "speed-normal" },
    { id: "fast", label: "Fast", className: "speed-fast" },
  ];
}

function readTrendPath(item, path, fallback = 0) {
  let cursor = item;
  for (const key of path) {
    cursor = cursor?.[key];
  }
  const value = Number(cursor);
  return Number.isFinite(value) ? value : fallback;
}

function chartSegmentDefinitions(metric, options = {}) {
  if (options.modelBreakdown) {
    const models = [...new Set((options.series || []).flatMap((item) => Object.keys(item.models || {})))].sort();
    return models.map((model) => ({
      key: model, label: window.ModelDisplay.format(model, { precision: "coarse" }), className: "model", color: modelColor(model),
      read: (item) => Math.max(0, readTrendPath(item, ["models", model, metric])),
    }));
  }
  const breakdown = Boolean(options.breakdown);
  const speedBreakdown = Boolean(options.speedBreakdown);
  const parts = breakdown ? compositionSegmentDefinitions(metric) : [];
  const metricKey = metric === "equivalentCostCents"
    ? "equivalentCostCents"
    : metric === "effective" ? "effective" : "total";
  if (!speedBreakdown) {
    return parts.map((part) => ({
      ...part,
      read: (item) => Math.max(0, Number(item[part.key]) || 0),
    }));
  }
  return speedLaneDefinitions().flatMap((lane) => {
    const fallback = (item) => (lane.id === "normal" && !item.speed ? Math.max(0, Number(item[metricKey]) || 0) : 0);
    if (!breakdown) {
      return [{
        key: `${lane.id}-${metricKey}`,
        label: lane.label,
        className: lane.className,
        read: (item) => Math.max(0, readTrendPath(item, ["speed", lane.id, metricKey], fallback(item))),
      }];
    }
    return parts.map((part) => ({
      key: `${lane.id}-${part.key}`,
      label: `${lane.label} · ${part.label}`,
      className: `${part.className} ${lane.className}`,
      read: (item) => Math.max(0, readTrendPath(item, ["speed", lane.id, part.key], lane.id === "normal" && !item.speed ? Number(item[part.key]) || 0 : 0)),
    }));
  });
}

function chartSvg(series, metric, range, breakdown = false, speedBreakdown = false, modelBreakdown = false) {
  if (!series?.length) return `<div class="empty-state">暂无趋势数据</div>`;
  const fullscreen = Boolean(windowState.fullscreen);
  const custom = range === "custom";
  const width = custom ? Math.max(fullscreen ? 1400 : 400, series.length * 10 + 100) : fullscreen ? 1400 : 400;
  const height = fullscreen ? 460 : 236;
  const left = fullscreen ? 76 : 45;
  const top = fullscreen ? 24 : 14;
  const plotWidth = custom || fullscreen ? width - left - 28 : 344;
  const plotHeight = fullscreen ? height - top - 76 : 170;
  const baseY = top + plotHeight;
  const stacked = breakdown || speedBreakdown || modelBreakdown;
  const segmentDefs = chartSegmentDefinitions(metric, { breakdown, speedBreakdown, modelBreakdown, series });
  const segmentValue = (item, def) => (def.read ? def.read(item) : Number(item[def.key]) || 0);
  const values = series.map((item) => stacked
    ? segmentDefs.reduce((sum, def) => sum + Math.max(0, segmentValue(item, def)), 0)
    : Math.max(0, Number(item[metric]) || 0));
  const maxValue = Math.max(...values, 1);
  const slot = plotWidth / series.length;
  const gap = custom ? 3 : fullscreen
    ? range === "month" ? 7 : range === "day" ? 12 : 32
    : range === "month" ? 2.2 : range === "day" ? 3.2 : 8;
  const barWidth = Math.max(3, slot - gap);
  const labelIndexes = custom
    ? new Set(series.map((_item, index) => index).filter((index) => index % Math.max(1, Math.ceil(85 / slot)) === 0))
    : range === "week"
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
      if (!stacked) {
        const y = baseY - barHeight;
        return `<g class="chart-column" data-chart-index="${index}">${hitbox}<rect class="chart-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="${Math.min(4, barWidth / 2)}"></rect>${label}</g>`;
      }
      let y = baseY;
      const rects = segmentDefs.map((def, segmentIndex) => {
        const segment = Math.max(0, segmentValue(item, def));
        const heightValue = segment ? Math.max(1, segment / maxValue * plotHeight) : 0;
        y -= heightValue;
        return `<rect class="chart-segment ${def.className}"${def.color ? ` fill="${def.color}"` : ""} x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${heightValue.toFixed(2)}" rx="${segmentIndex === segmentDefs.length - 1 ? Math.min(3, barWidth / 2) : 0}"></rect>`;
      }).join("");
      return `<g class="chart-column" data-chart-index="${index}">${hitbox}${rects}${label}</g>`;
    })
    .join("");
  return `<svg class="bar-chart${custom ? " custom-range" : ""}"${custom ? ` width="${width}"` : ""} viewBox="0 0 ${width} ${height}" role="img" aria-label="消耗柱状图">${grid}${bars}</svg>`;
}

function customTrendPayload() {
  return { count: settings.trendCustomCount || 1, unit: settings.trendCustomUnit || "day" };
}

async function loadCustomTrends() {
  const payload = customTrendPayload();
  const key = JSON.stringify(payload);
  const request = ++customTrendRequest;
  customTrendKey = key;
  customTrendLoading = true;
  customTrendError = "";
  customTrendUsage = null;
  try {
    const next = await window.widget.getTrendUsage(payload);
    if (request !== customTrendRequest) return;
    customTrendUsage = next;
  } catch (error) {
    if (request !== customTrendRequest) return;
    customTrendError = error?.message || String(error);
  }
  if (request !== customTrendRequest) return;
  customTrendLoading = false;
  if (snapshot.data && settings.trendRange === "custom") renderTrends(snapshot.data);
}

function renderTrends(d) {
  const range = settings.trendRange || "day";
  const custom = range === "custom";
  const chart = $("trendChart");
  const scrollKey = custom ? JSON.stringify(customTrendPayload()) : range;
  if (trendChartScroll.key !== scrollKey) {
    trendChartScroll = { key: scrollKey, left: 0 };
  } else if (chart.querySelector(".bar-chart")) {
    // Loading/error placeholders have no overflow; don't save their reset offset.
    trendChartScroll.left = chart.scrollLeft;
  }
  $("trendCustomForm").hidden = !custom;
  const formKey = JSON.stringify(customTrendPayload());
  if (customTrendFormKey !== formKey) {
    $("trendCustomCount").value = settings.trendCustomCount || 1;
    $("trendCustomUnit").value = settings.trendCustomUnit || "day";
    customTrendFormKey = formKey;
  }
  if (custom && customTrendKey !== JSON.stringify(customTrendPayload())) loadCustomTrends();
  const source = settings.dataSource || "all";
  const view = custom
    ? customTrendUsage?.sources?.[source] || { label: { all: "全部", cursor: "Cursor", codex: "Codex" }[source], trends: {}, costAvailable: true }
    : d.sources?.[source] || d.sources?.all || { trends: d.trends, costAvailable: true, label: "Cursor" };
  let metric = settings.trendMetric || "total";
  if (metric === "costCents") metric = "equivalentCostCents";
  const modelBreakdown = Boolean(settings.trendModelBreakdown);
  const breakdown = !modelBreakdown && Boolean(settings.trendBreakdown);
  const speedBreakdown = !modelBreakdown && Boolean(settings.trendSpeedBreakdown);
  if (metric === "equivalentCostCents" && !view.costAvailable) metric = "total";
  if (breakdown && metric === "effective") metric = "total";
  const series = view.trends?.[range] || [];
  const total = series.reduce((sum, item) => sum + (Number(item[metric]) || 0), 0);
  const peak = series.reduce((best, item) => !best || (item[metric] || 0) > (best[metric] || 0) ? item : best, null);
  const unit = window.TrendRange.units[settings.trendCustomUnit || "day"];
  const resolution = custom ? customTrendUsage?.range.label || `近 ${settings.trendCustomCount || 1} ${unit?.label || "天"}`
    : range === "day" ? "今天 · 每小时聚合" : range === "week" ? "最近 7 天 · 每日聚合" : "最近 30 天 · 每日聚合";
  const draftUnit = window.TrendRange.units[$("trendCustomUnit").value];
  $("trendCustomHint").textContent = customTrendError || `按${draftUnit?.bucketLabel || "小时"}聚合 · N 为 1–100`;
  $("trendResolution").textContent = `${view.label || "全部"} · ${resolution}`;
  $("trendTotal").textContent = formatMetric(total, metric);
  hideChartTooltip();
  chartTooltipContext = { series, metric, breakdown, speedBreakdown, modelBreakdown };
  $("trendChart").innerHTML = chartSvg(series, metric, range, breakdown, speedBreakdown, modelBreakdown);
  if (custom && (customTrendLoading || customTrendError)) {
    $("trendTotal").textContent = "—";
    $("trendChart").innerHTML = `<div class="empty-state">${customTrendLoading ? "正在读取历史趋势…" : `读取失败：${escapeHtml(customTrendError)}，请点击应用重试`}</div>`;
  }
  chart.scrollLeft = trendChartScroll.left;
  $("legendItems").innerHTML = trendLegendHtml(metric, breakdown, speedBreakdown, modelBreakdown, series);
  $("chartPeak").textContent = peak ? `峰值 ${peak.shortLabel} · ${formatMetric(peak[metric], metric)}` : "峰值 —";
  document.querySelectorAll("[data-range]").forEach((button) => button.classList.toggle("active", button.dataset.range === range));
  document.querySelectorAll("[data-metric]").forEach((button) => {
    button.disabled = button.dataset.metric === "equivalentCostCents" && !view.costAvailable;
    button.classList.toggle("active", button.dataset.metric === metric);
  });
  document.querySelectorAll("[data-source]").forEach((button) => button.classList.toggle("active", button.dataset.source === source));
  $("breakdownBtn").classList.toggle("active", breakdown);
  $("breakdownBtn").setAttribute("aria-pressed", String(breakdown));
  $("speedBreakdownBtn").classList.toggle("active", speedBreakdown);
  $("speedBreakdownBtn").setAttribute("aria-pressed", String(speedBreakdown));
  $("modelBreakdownBtn").classList.toggle("active", modelBreakdown);
  $("modelBreakdownBtn").setAttribute("aria-pressed", String(modelBreakdown));
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
  if (immediate || reducedMotion()) {
    chartTooltipPosition.x = target.x;
    chartTooltipPosition.y = target.y;
    $("chartTooltip").style.translate = `${target.x.toFixed(2)}px ${target.y.toFixed(2)}px`;
    if (chartTooltipFrame !== null) cancelAnimationFrame(chartTooltipFrame);
    chartTooltipFrame = null;
    return;
  }
  if (chartTooltipFrame === null) chartTooltipFrame = requestAnimationFrame(animateChartTooltip);
}

function trendModelSwatch(color) {
  return `<svg class="trend-model-swatch" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`;
}

function trendLegendHtml(metric, breakdown, speedBreakdown, modelBreakdown = false, series = []) {
  if (modelBreakdown) return chartSegmentDefinitions(metric, { modelBreakdown, series })
    .map((def) => `<span class="legend-key">${trendModelSwatch(def.color)}${escapeHtml(def.label)}</span>`).join("");
  const composition = breakdown
    ? `<span class="legend-key input"><i></i>输入</span><span class="legend-key cache-write"><i></i>缓存写入</span><span class="legend-key cache-read"><i></i>缓存读取</span><span class="legend-key output"><i></i>输出</span>`
    : "";
  const speed = speedBreakdown
    ? `<span class="legend-key speed-normal"><i></i>非 Fast</span><span class="legend-key speed-fast"><i></i>Fast</span>`
    : "";
  if (speed && composition) return `${speed}${composition}`;
  if (composition) return composition;
  if (speed) return speed;
  return `<i></i><b id="legendText">${metric === "effective" ? "有效 Token 新增" : metric === "total" ? "总 Token 新增（含缓存）" : "美元等效费用新增"}</b>`;
}

function fillChartTooltip(index) {
  const item = chartTooltipContext.series[index];
  if (!item) return false;
  const metric = chartTooltipContext.metric;
  const breakdown = Boolean(chartTooltipContext.breakdown);
  const speedBreakdown = Boolean(chartTooltipContext.speedBreakdown);
  const modelBreakdown = Boolean(chartTooltipContext.modelBreakdown);
  const definitions = breakdown || speedBreakdown || modelBreakdown
    ? chartSegmentDefinitions(metric, { breakdown, speedBreakdown, modelBreakdown, series: chartTooltipContext.series })
    : compositionSegmentDefinitions(metric);
  const parts = definitions.map((definition) => ({
    ...definition,
    value: Math.max(0, definition.read ? definition.read(item) : Number(item[definition.key]) || 0),
  })).filter((part) => !(speedBreakdown || modelBreakdown) || part.value > 0);
  const partTotal = parts.reduce((sum, part) => sum + part.value, 0);
  $("chartTooltip").classList.toggle("wide", modelBreakdown || Boolean(speedBreakdown && breakdown));
  $("chartTooltipLabel").textContent = item.label || item.shortLabel || "该时段";
  $("chartTooltipTotal").textContent = formatMetric(item[metric], metric);
  $("chartTooltipRows").innerHTML = parts.map((part) => {
    const percent = partTotal > 0 ? part.value / partTotal * 100 : 0;
    return `<div class="chart-tooltip-row ${part.className}"><span>${part.color ? trendModelSwatch(part.color) : "<i></i>"}${escapeHtml(part.label)}</span><b>${escapeHtml(formatMetric(part.value, metric))}</b><em>${percent.toFixed(percent >= 10 ? 0 : 1)}%</em></div>`;
  }).join("");
  $("chartTooltipMeta").innerHTML = `<span>${formatInteger(item.count)} 次调用</span><span>${metric === "equivalentCostCents" ? "事件价格已锁定" : metric === "effective" ? "不含缓存命中" : "包含缓存命中"}</span>`;
  return true;
}

function hideChartTooltip() {
  if (!$("chartTooltip")) return;
  chartTooltipVisible = false;
  chartHoveredIndex = -1;
  $("chartTooltip").classList.remove("visible", "wide");
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

function liveQuotaPoints(d) {
  if (!d) return [];
  const at = d.fetchedAt || Date.now();
  const windows = Array.isArray(d.codex?.quota?.windows) && d.codex.quota.windows.length
    ? d.codex.quota.windows
    : [d.codex?.quota?.primary, d.codex?.quota?.secondary].filter(Boolean);
  return [
    d.cursorModels && { source: "cursor", pool: "cursor-models", timestamp: at, usedPercent: d.cursorModels.percentUsed, resetsAt: d.billingCycleEnd, startsAt: d.billingCycleStart },
    d.otherModels && { source: "cursor", pool: "other-models", timestamp: at, usedPercent: d.otherModels.percentUsed, resetsAt: d.billingCycleEnd, startsAt: d.billingCycleStart },
    ...windows.map((window) => ({
      source: "codex",
      pool: `${window.slot || "window"}-${window.windowMinutes}`,
      timestamp: at,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetsAt: window.resetsAt,
    })),
  ].filter(Boolean);
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function speedLabel(event) {
  if (event?.fastKnown === false) return { text: "速度未知", className: "unknown" };
  return event?.fast ? { text: "Fast", className: "fast" } : { text: "非 Fast", className: "normal" };
}

function levelChartSvg(series, cycle) {
  if (!series?.length) return `<div class="empty-state">这个周期还没有水位采样</div>`;
  const fullscreen = Boolean(windowState.fullscreen);
  const width = fullscreen ? 1400 : 400;
  const height = fullscreen ? 420 : 232;
  const left = fullscreen ? 76 : 42;
  const top = fullscreen ? 24 : 14;
  const plotWidth = fullscreen ? width - left - 28 : 346;
  const plotHeight = fullscreen ? height - top - 64 : 168;
  const baseY = top + plotHeight;
  const values = series.map((item) => Number(item.remainingPercent) || 0);
  const maxValue = 100;
  const minAt = series[0].at;
  const maxAt = series[series.length - 1].at;
  const span = Math.max(1, maxAt - minAt);
  const xOf = (at) => left + ((at - minAt) / span) * plotWidth;
  const yOf = (value) => baseY - (value / maxValue) * plotHeight;
  const points = series.map((item) => `${xOf(item.at).toFixed(1)},${yOf(Number(item.remainingPercent) || 0).toFixed(1)}`);
  const area = `${left.toFixed(1)},${baseY.toFixed(1)} ${points.join(" ")} ${xOf(maxAt).toFixed(1)},${baseY.toFixed(1)}`;
  const ticks = [0, 50, 100].map((value) => {
    const y = yOf(value);
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"/><text class="axis-y" x="${left - 7}" y="${y + 4}" text-anchor="end">${value}%</text>`;
  }).join("");
  const labels = [series[0], series[Math.floor(series.length / 2)], series[series.length - 1]]
    .filter((item, index, list) => list.findIndex((entry) => entry.at === item.at) === index)
    .map((item) => `<text class="axis-x" x="${xOf(item.at).toFixed(1)}" y="${baseY + 22}" text-anchor="middle">${escapeHtml(formatDateTime(item.at))}</text>`)
    .join("");
  const dots = series.map((item, index) => item.projected ? "" : `<circle class="level-dot" data-level-index="${index}" cx="${xOf(item.at).toFixed(1)}" cy="${yOf(Number(item.remainingPercent) || 0).toFixed(1)}" r="2.4"></circle>`).join("");
  const hits = series.map((item, index) => {
    if (item.projected) return "";
    const x = xOf(item.at);
    const widthHit = Math.max(8, plotWidth / Math.max(series.length, 1));
    return `<rect class="chart-hitbox" data-level-index="${index}" x="${(x - widthHit / 2).toFixed(1)}" y="${top}" width="${widthHit.toFixed(1)}" height="${plotHeight}"></rect>`;
  }).join("");
  // Clip the reference to the existing data domain; never add its end to series.
  const reference = window.UsageCharts.uniformSegment(cycle, minAt, maxAt);
  const uniform = reference.length ? `<polyline class="uniform-line" points="${reference.map((point) => `${xOf(point.at).toFixed(1)},${yOf(point.remainingPercent).toFixed(1)}`).join(" ")}"><title>匀速使用：周期初 100%，周期末 0%</title></polyline>` : "";
  return `<svg class="bar-chart level-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="额度水位与匀速使用参考线">${ticks}<polygon class="level-area" points="${area}"></polygon>${uniform}<polyline class="level-line" points="${points.join(" ")}"></polyline>${dots}${hits}${labels}</svg>`;
}

function renderLevels() {
  const timeline = quotaTimeline || snapshot.data?.quotaTimeline;
  const pools = timeline?.pools || [];
  $("levelPoolSwitch").innerHTML = pools.map((pool) => (
    `<button type="button" data-level-pool="${escapeHtml(pool.id)}" class="${pool.id === (timeline?.pool || settings.quotaLevelPool) ? "active" : ""}"${pool.hasData ? "" : " disabled"}>${escapeHtml(pool.label.replace("Cursor ", "").replace("Codex ", "Codex "))}</button>`
  )).join("");
  const cycles = timeline?.cycles || [];
  $("levelCycleSelect").innerHTML = cycles.length
    ? cycles.map((cycle) => `<option value="${escapeHtml(cycle.key)}"${cycle.key === timeline.cycle?.key ? " selected" : ""}>${escapeHtml(cycle.label)}</option>`).join("")
    : `<option value="">暂无周期</option>`;
  $("levelSubtitle").textContent = timeline?.cycle
    ? `${pools.find((pool) => pool.id === timeline.pool)?.label || "额度池"} · ${timeline.cycle.label}`
    : "各账期内剩余额度变化";
  const start = timeline?.cycle?.startRemaining;
  const end = timeline?.cycle?.endRemaining;
  $("levelTotal").textContent = start == null && end == null ? "—" : `${formatCursorPct(start)} → ${formatCursorPct(end)}`;
  const sampleCount = timeline?.series?.filter((point) => !point.projected).length || 0;
  $("levelPeak").textContent = sampleCount
    ? `${sampleCount} 个采样点`
    : "尚无采样";
  $("levelChart").innerHTML = levelChartSvg(timeline?.series || [], timeline?.cycle);
  const reference = timeline?.cycle?.reference;
  $("uniformLegend").hidden = !reference;
  $("uniformNote").textContent = reference
    ? `${timeline.cycle.interrupted ? `本周期于 ${formatDateTime(timeline.cycle.endAt)} 提前重置，原定结束时间为 ${formatDateTime(timeline.cycle.scheduledEndAt)}。` : ""}虚线为匀速使用参考：${formatDateTime(reference.startAt)} 的 100% → ${formatDateTime(reference.endAt)} 的 0%。仅显示已有采样的时间范围。${reference.estimated ? " 周期起点按常规周期长度推算。" : ""}`
    : "周期结束时间未知，暂不显示匀速参考线。";
}

function eventCostCents(event) {
  return event?.equivalentCostCents;
}

function renderEvents() {
  const page = eventPage;
  $("eventSourceSwitch").querySelectorAll("[data-event-source]").forEach((button) => {
    button.classList.toggle("active", button.dataset.eventSource === (settings.eventSource || "all"));
  });
  if (!page) {
    $("eventCount").textContent = "读取中";
    $("eventSubtitle").textContent = "正在读取本地历史库";
    $("eventList").innerHTML = `<div class="empty-state">正在加载请求明细…</div>`;
    $("eventPager").innerHTML = "";
    return;
  }
  $("eventCount").textContent = `${formatInteger(page.total)} 次`;
  $("eventSubtitle").textContent = page.total ? `第 ${page.offset + 1}–${Math.min(page.offset + page.events.length, page.total)} 条` : "没有匹配的请求";
  $("eventList").innerHTML = page.events.length
    ? page.events.map((event) => {
      const speed = speedLabel(event);
      const model = window.ModelDisplay.format(event);
      return `<article class="event-row">
        <div class="event-row-top"><b>${escapeHtml(model)}</b><em>${escapeHtml(formatUsd(eventCostCents(event)))}</em></div>
        <div class="event-meta">
          <span>${escapeHtml(formatDateTime(event.timestamp))}</span>
          <span>${event.source === "codex" ? "Codex" : "Cursor"}</span>
          <span class="speed-pill ${speed.className}">${speed.text}</span>
        </div>
        <small>输入 ${formatTokens(event.input)} · 写缓存 ${formatTokens(event.cacheWrite)} · 读缓存 ${formatTokens(event.cacheRead)} · 输出 ${formatTokens(event.output)}</small>
      </article>`;
    }).join("")
    : `<div class="empty-state">没有匹配的请求记录</div>`;
  const pageCount = Math.max(1, Math.ceil((page.total || 0) / (page.limit || 40)));
  const current = Math.floor((page.offset || 0) / (page.limit || 40)) + 1;
  $("eventPager").innerHTML = `
    <button type="button" class="text-btn" id="eventPrev" ${page.offset <= 0 ? "disabled" : ""}>上一页</button>
    <span>${current} / ${pageCount}</span>
    <button type="button" class="text-btn" id="eventNext" ${page.offset + page.events.length >= page.total ? "disabled" : ""}>下一页</button>
  `;
  $("eventPrev")?.addEventListener("click", () => loadEventPage(Math.max(0, page.offset - page.limit)));
  $("eventNext")?.addEventListener("click", () => loadEventPage(page.offset + page.limit));
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `$${number}`;
}

function renderPricing() {
  const catalog = pricingCatalog;
  if (!catalog) {
    $("pricingCount").textContent = "读取中";
    $("pricingList").innerHTML = `<div class="empty-state">正在读取价目表…</div>`;
    return;
  }
  $("pricingSourceSwitch").querySelectorAll("[data-pricing-source]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pricingSource === (settings.pricingSource || "all"));
  });
  const snapshots = catalog.snapshots || [];
  $("pricingSnapshotSelect").innerHTML = snapshots.length
    ? snapshots.map((item, index) => {
      const latest = index === 0 ? "当日 · " : "历史 · ";
      const when = new Date(item.fetchedAt).toLocaleString("zh-CN");
      return `<option value="${item.id}"${Number(item.id) === Number(catalog.selectedId) ? " selected" : ""}>${latest}${escapeHtml(when)}</option>`;
    }).join("")
    : `<option value="">尚无已保存的价目表</option>`;
  $("pricingCount").textContent = `${formatInteger(catalog.rows?.length || 0)} 档`;
  $("pricingSubtitle").textContent = catalog.snapshot
    ? `${catalog.snapshot.status === "remote" || catalog.snapshot.status === "official" ? "官方" : "内置"}价目 · ${catalog.snapshot.modelCount} 个模型`
    : "按模型与 Fast / 非 Fast 分档";
  $("pricingNote").textContent = catalog.snapshot?.note || "价格单位为每百万 Token 美元。";
  $("pricingList").innerHTML = catalog.rows?.length
    ? `<div class="pricing-table-wrap"><table class="pricing-table">
      <thead>
        <tr>
          <th>来源</th>
          <th>模型</th>
          <th>速度</th>
          <th>上下文</th>
          <th>输入</th>
          <th>输出</th>
          <th>写缓存</th>
          <th>读缓存</th>
        </tr>
      </thead>
      <tbody>
        ${catalog.rows.map((row) => `
          <tr>
            <td>${row.source === "codex" ? "Codex" : "Cursor"}</td>
            <td>${escapeHtml(window.ModelDisplay.format(row.model, { precision: "coarse" }))}</td>
            <td><span class="speed-pill ${row.speed === "fast" ? "fast" : "normal"}">${escapeHtml(row.speedLabel)}</span></td>
            <td>${escapeHtml(row.contextLabel)}</td>
            <td>${escapeHtml(formatRate(row.input))}</td>
            <td>${escapeHtml(formatRate(row.output))}</td>
            <td>${escapeHtml(formatRate(row.cacheWrite))}</td>
            <td>${escapeHtml(formatRate(row.cacheRead))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table></div>`
    : `<div class="empty-state">这份价目表里没有可展示的档位</div>`;
}

function renderActiveView(d) {
  if (!d) return;
  if (settings.compact && !windowState.fullscreen && !settings.orbMode) { renderOverview(d); return; }
  if (settings.activeTab === "models") renderModels(d);
  else if (settings.activeTab === "trends") renderTrends(d);
  else if (settings.activeTab === "levels") renderLevels();
  else if (settings.activeTab === "events") renderEvents();
  else if (settings.activeTab === "pricing") renderPricing();
  else renderOverview(d);
}

function setActiveTab(tab, persist = false) {
  const valid = ["overview", "models", "trends", "levels", "events", "pricing"].includes(tab) ? tab : "overview";
  settings.activeTab = valid;
  const visible = settings.compact && !windowState.fullscreen && !settings.orbMode ? "overview" : valid;
  if (valid !== "trends" && valid !== "levels") hideChartTooltip();
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === visible);
    button.setAttribute("aria-current", button.dataset.tab === visible ? "page" : "false");
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${visible}View`));
  if (persist) {
    window.widget.saveSettings({ activeTab: valid });
    if (valid === "levels") loadQuotaTimeline();
    if (valid === "events") loadEventPage(0);
    if (valid === "pricing") loadPricingCatalog();
    renderActiveView(snapshot.data);
  }
}

function renderStatus() {
  const d = snapshot.data;
  $("bootstrapState").hidden = Boolean(d);
  if (!d) {
    $("bootstrapState").innerHTML = snapshot.loading
      ? '<span class="loading-indicator" aria-hidden="true"></span><b>正在读取用量</b><p>首次扫描可能需要一点时间，历史记录会完整保留。</p>'
      : '<b>暂时无法同步</b><p>请确认本机已有 Cursor 登录或 Codex 会话，然后点击顶栏刷新重试。</p>';
    $("planBadge").textContent = snapshot.loading ? "连接中" : "待同步";
    $("planLine").textContent = snapshot.loading ? "正在读取本机用量" : "等待可用数据";
  }
  const dot = $("liveDot");
  $("refreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
  $("refreshBtn").disabled = Boolean(snapshot.loading);
  $("priceBtn").disabled = Boolean(snapshot.loading);
  $("orbRefreshBtn").disabled = Boolean(snapshot.loading);
  $("orbRefreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
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
  if (cursorState?.ok === false || codexState?.ok === false) dot.className = "live-dot warning";
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
  $("syncCountdown").textContent = seconds > 0 ? `${seconds}s 后刷新` : "等待同步";
}

function renderSourceHealth() {
  const status = snapshot.data?.sourceStatus || {};
  $("sourceHealth").innerHTML = `<b>数据来源</b>${["cursor", "codex"].map((source) => {
    const state = status[source];
    const label = source === "cursor" ? "Cursor 云端" : "Codex 本机";
    const healthy = snapshot.ok && state?.ok;
    const text = snapshot.loading ? "同步中" : healthy ? "已同步" : state?.cached ? "使用缓存" : "暂不可用";
    return `<div><span>${label}</span><strong class="${healthy ? "healthy" : "warning"}">${text}</strong></div>`;
  }).join("")}<small>${snapshot.data?.fetchedAt ? `最近采集 ${escapeHtml(formatDateTime(snapshot.data.fetchedAt))}` : "等待首次采集"} · 历史 ${formatInteger(snapshot.data?.persistence?.count || 0)} 条<br>缓存可能滞后；同步失败不会删除已保存的历史。可点顶栏刷新重试。</small>`;
}

function render() {
  const orbMode = Boolean(settings.orbMode) && !windowState.fullscreen;
  document.body.classList.toggle("compact", Boolean(settings.compact) && !windowState.fullscreen && !orbMode);
  document.body.classList.toggle("fullscreen", Boolean(windowState.fullscreen));
  document.body.classList.toggle("orb-mode", orbMode);
  document.body.classList.toggle("orb-pool-layout", orbMode && settings.orbDisplayMode === "pool");
  document.body.classList.toggle("orb-pool-combined", orbMode && poolViewCombined());
  document.body.classList.toggle("privacy", Boolean(settings.privacyMode));
  document.body.classList.toggle("reduce-motion", reducedMotion());
  document.body.classList.toggle("smart-docked", Boolean(windowState.smartDocked));
  $("compactBtn").classList.toggle("active", Boolean(settings.compact) && !windowState.fullscreen && !orbMode);
  $("compactBtn").disabled = Boolean(windowState.fullscreen);
  $("orbBtn").classList.toggle("active", orbMode);
  $("orbBtn").disabled = Boolean(windowState.fullscreen);
  $("fullscreenBtn").classList.toggle("active", Boolean(windowState.fullscreen));
  $("fullscreenBtn").textContent = windowState.fullscreen ? "↙" : "⛶";
  $("fullscreenBtn").title = windowState.fullscreen ? "退出全屏（Esc / F11）" : "全屏仪表盘（F11）";
  $("smartBtn").classList.toggle("active", smartPanelOpen || settings.privacyMode);
  $("smartPanel").hidden = !smartPanelOpen || orbMode;
  $("smartDockToggle").checked = Boolean(settings.smartDock);
  $("privacyToggle").checked = Boolean(settings.privacyMode);
  $("startupToggle").checked = Boolean(settings.openAtLogin);
  $("motionSelect").value = settings.motionPreference || "system";
  $("alertToggle").checked = Boolean(settings.quotaAlerts);
  $("alertThresholdSelect").value = String(settings.alertThreshold || 20);
  $("alertThresholdSelect").disabled = !settings.quotaAlerts;
  $("opacity").value = Math.round((settings.opacity ?? 0.96) * 100);
  $("intervalSelect").value = String(settings.intervalMs || 30_000);
  $("modelRangeSelect").value = settings.modelRange || "month1";
  setActiveTab(settings.activeTab, false);
  renderStatus();
  if (smartPanelOpen) renderSourceHealth();
  const d = snapshot.data;
  renderOrb(d);
  if (!d) return;
  if (d.modelUsage?.key === settings.modelRange && modelUsage?.key !== settings.modelRange) modelUsage = d.modelUsage;
  $("planBadge").textContent = d.codex && d.cursorModels ? "双源" : d.codex ? "Codex" : d.planName || "Cursor";
  const accountParts = [];
  if (d.email) accountParts.push(displayEmail(d.email));
  if (d.cursorModels) accountParts.push(`Cursor ${d.planName || ""}`.trim());
  if (d.codex) accountParts.push(`Codex ${d.codex.planName || ""}`.trim());
  $("planLine").textContent = accountParts.join(" · ") || "本机用量历史";
  $("priceBtn").title = d.pricing?.fetchedAt
    ? `手动更新官方价目表 · 当前 ${new Date(d.pricing.fetchedAt).toLocaleString("zh-CN")}`
    : "手动更新官方价目表";
  if (!orbMode) renderActiveView(d);
}

function scheduleRender() {
  if (fullscreenRequestInFlight) return;
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    if (!fullscreenRequestInFlight) render();
  });
}

async function setFullscreen(force) {
  if (fullscreenRequestInFlight || windowState.fullscreenTransition) return;
  if (typeof force === "boolean" && force === Boolean(windowState.fullscreen)) return;
  fullscreenRequestInFlight = true;
  let plan = null;
  const wasInert = document.body.inert;
  document.body.inert = true;
  try {
    endTitlebarDrag();
    if (!reducedMotion() && document.startViewTransition && window.widget.prepareFullscreenMorph) {
      plan = await window.widget.prepareFullscreenMorph(force);
      if (plan) {
        fullscreenMorph.stage(plan, !plan.fullscreen);
        await window.widget.stageFullscreenMorph(plan.id);
        // The native viewport stays fixed for the entire shared-element transition.
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await fullscreenMorph.animate(plan, () => {
          windowState = { ...windowState, fullscreen: plan.fullscreen };
          render();
        });
        const next = await window.widget.finishFullscreenMorph(plan.id);
        windowState = { ...windowState, ...next };
      }
    } else {
      const next = await window.widget.toggleFullscreen(force);
      windowState = { ...windowState, ...next };
    }
  } catch (error) {
    console.error("切换全屏失败", error);
    if (plan) {
      const next = await window.widget.finishFullscreenMorph(plan.id).catch(() => null);
      if (next) windowState = { ...windowState, ...next };
    }
  } finally {
    fullscreenMorph.cleanup();
    document.body.inert = wasInert;
    fullscreenRequestInFlight = false;
    render();
  }
}

function applyWindowState(next) {
  if (fullscreenRequestInFlight) return;
  windowState = { ...windowState, ...next };
  scheduleRender();
}

function setSmartPanel(open) {
  smartPanelOpen = Boolean(open);
  $("smartPanel").hidden = !smartPanelOpen || Boolean(settings.orbMode);
  $("smartBtn").classList.toggle("active", smartPanelOpen || settings.privacyMode);
  $("smartBtn").setAttribute("aria-expanded", String(smartPanelOpen));
  document.querySelectorAll(".shell > header, .sync-strip, .tabs, main.content, footer").forEach((element) => { element.inert = smartPanelOpen; });
  if (smartPanelOpen) {
    previousPanelFocus = document.activeElement;
    renderSourceHealth();
    $("smartCloseBtn").focus();
  } else if (previousPanelFocus?.isConnected) previousPanelFocus.focus();
}

async function loadQuotaTimeline() {
  if (!window.widget.getQuotaTimeline) {
    quotaTimeline = snapshot.data?.quotaTimeline || null;
    if (settings.activeTab === "levels") renderLevels();
    return;
  }
  const request = ++quotaTimelineRequest;
  try {
    const next = await window.widget.getQuotaTimeline({
      pool: settings.quotaLevelPool,
      cycleKey: selectedCycleKey,
      now: Date.now(),
      live: liveQuotaPoints(snapshot.data),
    });
    if (request !== quotaTimelineRequest) return;
    quotaTimeline = next;
    selectedCycleKey = next?.cycle?.key || selectedCycleKey;
    if (settings.activeTab === "levels") renderLevels();
  } catch (error) {
    if (request !== quotaTimelineRequest) return;
    showToast("额度水位读取失败，可刷新重试", true);
    console.error("读取额度水位失败", error);
  }
}

async function loadEventPage(offset = 0) {
  if (!window.widget.queryUsageEvents) {
    eventPage = eventPage || { total: 0, offset: 0, limit: 40, events: [] };
    if (settings.activeTab === "events") renderEvents();
    return;
  }
  const request = ++eventPageRequest;
  try {
    const next = await window.widget.queryUsageEvents({
      source: settings.eventSource || "all",
      query: eventQueryDraft,
      offset,
      limit: 40,
    });
    if (request !== eventPageRequest) return;
    eventPage = next;
    if (settings.activeTab === "events") renderEvents();
  } catch (error) {
    if (request !== eventPageRequest) return;
    showToast("请求明细读取失败，可刷新重试", true);
    console.error("读取请求明细失败", error);
  }
}

async function loadPricingCatalog() {
  if (!window.widget.getPricingCatalog) {
    if (settings.activeTab === "pricing") renderPricing();
    return;
  }
  const request = ++pricingCatalogRequest;
  try {
    const next = await window.widget.getPricingCatalog({
      snapshotId: selectedPricingId,
      source: settings.pricingSource || "all",
    });
    if (request !== pricingCatalogRequest) return;
    pricingCatalog = next;
    selectedPricingId = next?.selectedId ?? selectedPricingId;
    if (settings.activeTab === "pricing") renderPricing();
  } catch (error) {
    if (request !== pricingCatalogRequest) return;
    showToast("价目表读取失败，可刷新重试", true);
    console.error("读取价目表失败", error);
  }
}

let exportBusy = false;
let toastTimer;
function showToast(message, error = false) {
  const toast = $("actionToast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 9000 : 5000);
}

async function exportEvents(kind) {
  if (exportBusy) return;
  if (!window.widget.exportUsageEvents) { showToast("请在桌面应用中导出完整历史"); return; }
  exportBusy = true;
  const buttons = [$("eventExportCsv"), $("eventExportJson")];
  buttons.forEach((button) => { button.disabled = true; });
  $("eventExport" + (kind === "csv" ? "Csv" : "Json")).textContent = "正在导出…";
  // Capture the filter before opening the native save dialog.
  const filter = { kind, source: settings.eventSource || "all", query: eventQueryDraft };
  try {
    const result = await window.widget.exportUsageEvents(filter);
    if (result?.canceled) showToast("已取消导出");
    else if (result?.ok) showToast(`已导出 ${formatInteger(result.count)} 条请求`);
    else showToast(result?.error || "导出失败，请重试", true);
  } catch { showToast("导出失败，请重试", true); }
  finally {
    exportBusy = false;
    buttons.forEach((button) => { button.disabled = false; });
    $("eventExportCsv").textContent = "导出 CSV";
    $("eventExportJson").textContent = "导出 JSON";
  }
}

function handleLevelPointerMove(event) {
  const hit = event.target.closest("[data-level-index]");
  if (!hit) {
    hideChartTooltip();
    return;
  }
  const index = Number(hit.dataset.levelIndex);
  const point = quotaTimeline?.series?.[index];
  if (!point) return;
  $("chartTooltipLabel").textContent = formatDateTime(point.at);
  $("chartTooltipTotal").textContent = `剩余 ${formatCursorPct(point.remainingPercent)}`;
  $("chartTooltipRows").innerHTML = `<div>已用 ${formatCursorPct(point.usedPercent)}</div>`;
  const uniform = window.UsageCharts.uniformRemaining(quotaTimeline?.cycle, point.at);
  if (uniform != null) $("chartTooltipRows").innerHTML += `<div>匀速参考剩余 ${formatCursorPct(uniform)}</div><div>实际水位${point.remainingPercent >= uniform ? "高于" : "低于"}参考 ${Math.abs(point.remainingPercent - uniform).toFixed(2)} 个百分点</div>`;
  $("chartTooltipMeta").textContent = quotaTimeline?.cycle?.label || "";
  const firstShow = !chartTooltipVisible;
  chartTooltipVisible = true;
  $("chartTooltip").classList.add("visible");
  $("chartTooltip").setAttribute("aria-hidden", "false");
  moveChartTooltip(event.clientX, event.clientY, firstShow);
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab, true));
});
$("trendChart").addEventListener("pointermove", handleChartPointerMove, { passive: true });
$("trendChart").addEventListener("pointerleave", hideChartTooltip);
$("levelChart").addEventListener("pointermove", handleLevelPointerMove, { passive: true });
$("levelChart").addEventListener("pointerleave", hideChartTooltip);
$("levelPoolSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("[data-level-pool]");
  if (!button || button.disabled) return;
  settings.quotaLevelPool = button.dataset.levelPool;
  selectedCycleKey = null;
  window.widget.saveSettings({ quotaLevelPool: settings.quotaLevelPool });
  loadQuotaTimeline();
});
$("levelCycleSelect").addEventListener("change", (event) => {
  selectedCycleKey = event.target.value || null;
  loadQuotaTimeline();
});
$("eventSourceSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("[data-event-source]");
  if (!button) return;
  settings.eventSource = button.dataset.eventSource;
  window.widget.saveSettings({ eventSource: settings.eventSource });
  loadEventPage(0);
});
$("eventSearch").addEventListener("input", (event) => {
  eventQueryDraft = event.target.value;
  eventPageRequest += 1;
  clearTimeout(eventSearchTimer);
  eventSearchTimer = setTimeout(() => loadEventPage(0), 220);
});
$("eventExportCsv").addEventListener("click", () => exportEvents("csv"));
$("eventExportJson").addEventListener("click", () => exportEvents("json"));
$("pricingSourceSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("[data-pricing-source]");
  if (!button) return;
  settings.pricingSource = button.dataset.pricingSource;
  window.widget.saveSettings({ pricingSource: settings.pricingSource });
  loadPricingCatalog();
});
$("pricingSnapshotSelect").addEventListener("change", (event) => {
  selectedPricingId = event.target.value ? Number(event.target.value) : null;
  loadPricingCatalog();
});
document.querySelectorAll("[data-source]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.dataSource = button.dataset.source;
    const view = settings.trendRange === "custom"
      ? customTrendUsage?.sources?.[settings.dataSource]
      : snapshot.data?.sources?.[settings.dataSource];
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

$("trendCustomUnit").addEventListener("change", () => {
  const unit = window.TrendRange.units[$("trendCustomUnit").value];
  $("trendCustomHint").textContent = `按${unit.bucketLabel}聚合 · N 为 1–100`;
});
$("trendCustomForm").addEventListener("submit", (event) => {
  event.preventDefault();
  let range;
  try {
    range = window.TrendRange.normalize({ count: $("trendCustomCount").value, unit: $("trendCustomUnit").value });
  } catch (error) {
    $("trendCustomHint").textContent = error.message;
    return;
  }
  settings.trendRange = "custom";
  settings.trendCustomCount = range.count;
  settings.trendCustomUnit = range.unit;
  window.widget.saveSettings({ trendRange: "custom", trendCustomCount: range.count, trendCustomUnit: range.unit });
  loadCustomTrends();
  if (snapshot.data) renderTrends(snapshot.data);
});

$("breakdownBtn").addEventListener("click", () => {
  settings.trendBreakdown = !settings.trendBreakdown;
  settings.trendModelBreakdown = false;
  const partial = { trendBreakdown: settings.trendBreakdown, trendModelBreakdown: false };
  if (settings.trendBreakdown && settings.trendMetric === "effective") {
    settings.trendMetric = "total";
    partial.trendMetric = "total";
  }
  window.widget.saveSettings(partial);
  if (snapshot.data) renderTrends(snapshot.data);
});
$("speedBreakdownBtn").addEventListener("click", () => {
  settings.trendSpeedBreakdown = !settings.trendSpeedBreakdown;
  settings.trendModelBreakdown = false;
  window.widget.saveSettings({ trendSpeedBreakdown: settings.trendSpeedBreakdown, trendModelBreakdown: false });
  if (snapshot.data) renderTrends(snapshot.data);
});
$("modelBreakdownBtn").addEventListener("click", () => {
  settings.trendModelBreakdown = !settings.trendModelBreakdown;
  if (settings.trendModelBreakdown) {
    settings.trendBreakdown = false;
    settings.trendSpeedBreakdown = false;
  }
  window.widget.saveSettings({ trendModelBreakdown: settings.trendModelBreakdown,
    trendBreakdown: settings.trendBreakdown, trendSpeedBreakdown: settings.trendSpeedBreakdown });
  if (snapshot.data) renderTrends(snapshot.data);
});

$("refreshBtn").addEventListener("click", () => window.widget.refresh());
$("priceBtn").addEventListener("click", () => window.widget.refreshPricing());
$("fullscreenBtn").addEventListener("click", () => setFullscreen());
let titlebarPointer = null;
const titlebarControls = ".window-actions, button, input, select, a";
$("titlebar").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || windowState.fullscreen || windowState.fullscreenTransition || fullscreenRequestInFlight || event.target.closest(titlebarControls)) return;
  titlebarPointer = event.pointerId;
  $("titlebar").setPointerCapture(event.pointerId);
  window.widget.titlebarDrag?.("start");
});
$("titlebar").addEventListener("pointermove", (event) => {
  if (event.pointerId === titlebarPointer && !windowState.fullscreen) window.widget.titlebarDrag?.("move");
});
function endTitlebarDrag(event) {
  if (event && event.pointerId !== titlebarPointer) return;
  const pointer = titlebarPointer;
  titlebarPointer = null;
  if (pointer === null) return;
  if ($("titlebar").hasPointerCapture(pointer)) $("titlebar").releasePointerCapture(pointer);
  window.widget.titlebarDrag?.("end");
}
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
  $("titlebar").addEventListener(name, endTitlebarDrag);
}
window.addEventListener("blur", () => endTitlebarDrag());
$("titlebar").addEventListener("dblclick", (event) => {
  if (event.button !== 0 || event.target.closest(titlebarControls)) return;
  event.preventDefault();
  setFullscreen();
});
$("exitFullscreenBtn").addEventListener("click", () => setFullscreen(false));
$("orbBtn").addEventListener("click", () => window.widget.saveSettings({ orbMode: true, compact: false }));
$("closeBtn").addEventListener("click", () => window.widget.hide());
$("dashBtn").addEventListener("click", () => window.widget.openDashboard());
$("compactBtn").addEventListener("click", () => window.widget.saveSettings({ compact: !settings.compact, orbMode: false }));
$("smartBtn").addEventListener("click", () => setSmartPanel(!smartPanelOpen));
$("healthBtn").addEventListener("click", () => setSmartPanel(true));
$("smartCloseBtn").addEventListener("click", () => setSmartPanel(false));
$("quotaGlance").addEventListener("click", (event) => {
  const target = event.target.closest("[data-quota-target]")?.dataset.quotaTarget;
  if (["cursorPool", "otherPool", "codexPool"].includes(target)) {
    $(target).scrollIntoView({ behavior: reducedMotion() ? "instant" : "smooth", block: "start" });
  }
});
$("motionSelect").addEventListener("change", (event) => window.widget.saveSettings({ motionPreference: event.target.value }));
$("startupToggle").addEventListener("change", (event) => window.widget.saveSettings({ openAtLogin: event.target.checked }));
// WIP: 智能贴边、额度提醒、提醒阈值有严重 bug，入口已关闭。
$("smartDockToggle").addEventListener("change", (event) => window.widget.saveSettings({ smartDock: event.target.checked }));
$("privacyToggle").addEventListener("change", (event) => window.widget.saveSettings({ privacyMode: event.target.checked }));
$("alertToggle").addEventListener("change", (event) => window.widget.saveSettings({ quotaAlerts: event.target.checked }));
$("alertThresholdSelect").addEventListener("change", (event) => window.widget.saveSettings({ alertThreshold: Number(event.target.value) }));
$("modelRangeSelect").addEventListener("change", (event) => loadModelRange(event.target.value));
document.querySelectorAll("[data-model-view]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.modelView = button.dataset.modelView;
    window.widget.saveSettings({ modelView: settings.modelView });
    if (snapshot.data) renderModels(snapshot.data);
  });
});
$("modelMetricSelect").addEventListener("change", (event) => {
  settings.modelMetric = event.target.value;
  window.widget.saveSettings({ modelMetric: settings.modelMetric });
  if (snapshot.data) renderModels(snapshot.data);
});
for (const type of ["pointerover", "focusin", "click"]) {
  $("modelDonutContent").addEventListener(type, (event) => {
    const target = event.target.closest("[data-donut-index]");
    if (target) highlightModelDonut(Number(target.dataset.donutIndex));
  });
}
$("modelDonutContent").addEventListener("pointerleave", () => highlightModelDonut());
$("modelDonutContent").addEventListener("focusout", (event) => {
  if (!$("modelDonutContent").contains(event.relatedTarget)) highlightModelDonut();
});
$("orbPrevBtn").addEventListener("click", () => changeOrbPool(-1));
$("orbNextBtn").addEventListener("click", () => changeOrbPool(1));
document.querySelectorAll("[data-orb-display]").forEach((button) => {
  button.addEventListener("click", () => {
    settings.orbDisplayMode = button.dataset.orbDisplay;
    window.widget.saveSettings({ orbDisplayMode: settings.orbDisplayMode });
    renderOrb(snapshot.data);
  });
});
const orbShapeSwitch = $("orbShapeSwitch");
if (orbShapeSwitch) {
  orbShapeSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("[data-orb-shape]");
    if (!button) return;
    const shape = window.LiquidPool.normalizeTankShape(button.dataset.orbShape);
    if (shape === currentTankShape()) return;
    settings.orbPoolShape = shape;
    window.widget.saveSettings({ orbPoolShape: shape });
    renderOrb(snapshot.data);
  });
}
const orbCombinedBtn = $("orbCombinedBtn");
if (orbCombinedBtn) {
  orbCombinedBtn.addEventListener("click", () => {
    settings.orbPoolCombined = !settings.orbPoolCombined;
    window.widget.saveSettings({ orbPoolCombined: settings.orbPoolCombined });
    render();
  });
}
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
$("opacity").addEventListener("change", () => window.widget.saveSettings({ opacity: settings.opacity }));

window.widget.onSnapshot((next) => {
  recordLiquidSnapshot(next, true);
  snapshot = next;
  if (next.loading) {
    renderStatus();
    if (smartPanelOpen) renderSourceHealth();
    return;
  }
  customTrendKey = null;
  customTrendRequest += 1;
  customTrendLoading = false;
  if (next.data?.modelUsage?.key === settings.modelRange) modelUsage = next.data.modelUsage;
  if (next.data?.quotaTimeline && !quotaTimeline) quotaTimeline = next.data.quotaTimeline;
  if (settings.activeTab === "levels") loadQuotaTimeline();
  if (settings.activeTab === "events") loadEventPage(eventPage?.offset || 0);
  if (settings.activeTab === "pricing") loadPricingCatalog();
  scheduleRender();
});
window.widget.onSettings((next) => {
  settings = { ...settings, ...next };
  if (settings.orbMode && smartPanelOpen) setSmartPanel(false);
  scheduleRender();
});
window.widget.onWindowState((next) => {
  applyWindowState(next);
});
window.widget.onWindowMotion?.(handleWindowMotion);
window.widget.onFullscreenRequest?.(setFullscreen);

window.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && smartPanelOpen) {
    const items = [...$("smartPanel").querySelectorAll("button, select, input")].filter((item) => !item.disabled && item.getClientRects().length);
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.key === "Escape" && smartPanelOpen) {
    event.preventDefault();
    setSmartPanel(false);
  } else if (event.key === "F11" || (event.key === "Escape" && windowState.fullscreen)) {
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

document.documentElement.addEventListener("mouseenter", () => window.widget.setPointerPresence?.(true));
document.documentElement.addEventListener("mouseleave", () => window.widget.setPointerPresence?.(false));

systemMotion.addEventListener("change", scheduleRender);
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("view-hidden", document.hidden);
  if (document.hidden) { stopLiquidAnimation(); hideChartTooltip(); }
  else scheduleRender();
});
new ResizeObserver(() => {
  if (!document.hidden && settings.orbMode && settings.orbDisplayMode === "pool" && reducedMotion()) drawLiquid(0);
}).observe($("orbPoolGallery"));
setInterval(() => {
  if (document.hidden) return;
  renderStatus();
  if (settings.orbMode && !windowState.fullscreen) {
    // Only countdown text depends on the clock. Quota amounts come from snapshots.
    renderOrbResets(snapshot.data);
  }
}, 1000);
Promise.all([window.widget.getSettings(), window.widget.getSnapshot(), window.widget.getWindowState()]).then(([savedSettings, initialSnapshot, initialWindowState]) => {
  settings = { ...settings, ...savedSettings };
  recordLiquidSnapshot(initialSnapshot, false);
  snapshot = initialSnapshot;
  modelUsage = initialSnapshot.data?.modelUsage || null;
  quotaTimeline = initialSnapshot.data?.quotaTimeline || null;
  windowState = { ...windowState, ...initialWindowState };
  if ($("eventSearch")) $("eventSearch").value = eventQueryDraft;
  render();
  if (settings.activeTab === "levels") loadQuotaTimeline();
  if (settings.activeTab === "events") loadEventPage(0);
  if (settings.activeTab === "pricing") loadPricingCatalog();
});
