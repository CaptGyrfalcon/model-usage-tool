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
let smartPanelOpen = false;
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
  intervalMs: 30_000,
  activeTab: "overview",
  modelRange: "month1",
  modelPrecision: "coarse",
  trendRange: "day",
  trendMetric: "total",
  trendBreakdown: false,
  trendSpeedBreakdown: false,
  dataSource: "all",
  smartDock: false,
  privacyMode: false,
  quotaAlerts: true,
  alertThreshold: 20,
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
  if (settings.privacyMode) return "••••";
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(digits)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(digits)}K`;
  return String(Math.round(v));
}

function formatUsd(cents) {
  if (settings.privacyMode) return "••••";
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
    const used = Number.isFinite(Number(quota.usedPercent)) ? Number(quota.usedPercent) : 100 - Number(quota.percentRemaining);
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
    d?.codex?.quotaEquivalent?.inferredTotalCents
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
    const ambient = Math.sin(progress * Math.PI * 3.2 + time * 0.0028 + phase) * amplitude;
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
  ctx.beginPath();
  ctx.ellipse(rect.width / 2, rect.height / 2, rect.width / 2 - 1.5, rect.height / 2 - 1.5, 0, 0, Math.PI * 2);
  ctx.clip();
  if (config.source === "codex") {
    liquidFill(ctx, rect.width, rect.height, levels.weeklyLevel, time, {
      top: "rgba(122, 137, 255, 0.92)", bottom: "rgba(58, 75, 176, 0.96)", phase: 1.8, amplitude: 0.75,
    });
  }
  liquidFill(ctx, rect.width, rect.height, levels.level, time, {
    top: "rgba(76, 226, 186, 0.94)", bottom: "rgba(22, 126, 132, 0.98)", phase: 0, amplitude: 1.05,
  });
  const levelY = rect.height - 3 - (rect.height - 6) * window.LiquidPool.clamp(levels.level) / 100;
  for (const particle of liquidState.particles) {
    ctx.globalAlpha = Math.max(0, particle.life);
    ctx.fillStyle = config.source === "codex" && particle.weekly ? "#8b9aff" : "#7cf2ce";
    ctx.beginPath();
    ctx.arc(particle.x, levelY + particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLiquid(time) {
  const configs = new Map(liquidState.configs.map((config) => [config.id, config]));
  document.querySelectorAll(".usage-liquid").forEach((canvas) => {
    const config = configs.get(canvas.dataset.poolId);
    drawLiquidCanvas(canvas, config, liquidState.levels.get(config?.id), time);
  });
}

function maxLiquidLevel() {
  return Math.max(0, ...[...liquidState.levels.values()].map((levels) => Number(levels.level) || 0));
}

function stepLiquid(time) {
  liquidState.raf = null;
  if (!document.body.classList.contains("orb-mode") || settings.orbDisplayMode !== "pool") return;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const dt = liquidState.lastFrame ? Math.min(0.034, Math.max(0.008, (time - liquidState.lastFrame) / 1000)) : 1 / 60;
  liquidState.lastFrame = time;
  for (const config of liquidState.configs) {
    const levels = liquidState.levels.get(config.id);
    if (!levels) continue;
    levels.level += ((config.remaining || 0) - levels.level) * Math.min(1, dt * 6.5);
    levels.weeklyLevel += ((config.weeklyRemaining || config.remaining || 0) - levels.weeklyLevel) * Math.min(1, dt * 6.5);
  }
  if (!reducedMotion) {
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
  for (const config of liquidState.configs) {
    if (!liquidState.levels.has(config.id)) {
      liquidState.levels.set(config.id, { level: 0, weeklyLevel: 0 });
    }
  }
  if (!liquidState.raf) {
    liquidState.lastFrame = 0;
    liquidState.raf = requestAnimationFrame(stepLiquid);
  }
}

function splashLiquid(strength, direction = 0) {
  const amount = Math.min(6, Math.max(2, Math.round(strength * 3)));
  for (let index = 0; index < amount; index += 1) {
    liquidState.particles.push({
      x: 56 + direction * 25 + (Math.random() - 0.5) * 20,
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
  if (!(Number(effect?.amountCents) > 0)) return;
  const card = [...document.querySelectorAll("[data-usage-pool]")].find((element) => element.dataset.usagePool === effect?.id);
  const damage = card?.querySelector(".orb-damage");
  const drain = card?.querySelector(".orb-drain");
  if (!damage || !drain || !effect) return;
  const parts = settings.privacyMode
    ? { major: "-$••.••", minor: "••" }
    : window.LiquidPool.damageParts(effect.amountCents);
  damage.innerHTML = `<span>${parts.major}</span><small>${parts.minor}</small>`;
  damage.setAttribute("aria-label", settings.privacyMode ? "本次用量已隐藏" : `本次用量${parts.major}${parts.minor}`);
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
  $("orbResetList").innerHTML = insights.length
    ? insights.map((insight) => {
      const atRisk = insight.forecast?.status === "exhaust";
      const detail = compact
        ? ""
        : `<small>${escapeHtml(formatQuotaReset(insight.resetsAt) || "等待重置时间")} · ${escapeHtml(forecastText(insight))}</small>`;
      return `<div class="orb-reset-row ${atRisk ? "at-risk" : "safe"}">
        <span><b>${escapeHtml(insight.label)}</b>${detail}</span>
        <em class="orb-reset-time">${escapeHtml(formatUntil(insight.resetsAt))}</em>
      </div>`;
    }).join("")
    : `<div class="orb-reset-empty">正在同步全部额度重置时间…</div>`;
}

function renderUsagePoolGallery(pools) {
  const gallery = $("orbPoolGallery");
  const signature = JSON.stringify(pools.map((pool) => [
    pool.id, pool.remaining, pool.shortRemaining, pool.weeklyRemaining, pool.weeklyOnlyRemaining,
    pool.capacityCents, pool.shortCapacityCents, pool.sizeScale, settings.privacyMode,
  ]));
  if (gallery.dataset.signature !== signature) {
    gallery.dataset.signature = signature;
    gallery.innerHTML = pools.map((pool) => {
      const displayedRemaining = pool.source === "codex" ? pool.shortRemaining : pool.remaining;
      const pct = pool.precision === 2 ? formatCursorPct(displayedRemaining) : formatPct(displayedRemaining);
      const scale = Number(pool.sizeScale) > 0 ? Number(pool.sizeScale) : 1;
      const codexLegend = pool.source === "codex"
        ? `<div class="usage-pool-legend"><span><i class="immediate"></i>5 小时可用 ${escapeHtml(formatCursorPct(pool.shortRemaining))}</span><span><i class="weekly"></i>仅周池可用 ${escapeHtml(formatPct(pool.weeklyOnlyRemaining))}</span></div>`
        : "";
      const capacity = pool.source === "codex"
        ? `7天 ${formatUsd(pool.capacityCents)} · 5小时 ${formatUsd(pool.shortCapacityCents)}`
        : liquidCapacityText(pool);
      return `<article class="usage-pool-card" data-usage-pool="${escapeHtml(pool.id)}">
        <div class="usage-pool-slot">
          <div class="usage-pool-tank${pool.source === "codex" ? " codex" : ""}" data-tank-scale="${scale.toFixed(4)}" role="meter" aria-label="${escapeHtml(pool.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(displayedRemaining).toFixed(2)}">
            <canvas class="usage-liquid" data-pool-id="${escapeHtml(pool.id)}" aria-hidden="true"></canvas>
            <i class="orb-drain" aria-hidden="true"></i>
            <output class="orb-damage" aria-live="polite"></output>
          </div>
        </div>
        <div class="usage-pool-info">
          <b>${escapeHtml(pool.name)}</b>
          <strong>${escapeHtml(pct)}<small>${pool.source === "codex" ? " 5小时可用" : " 可用"}</small></strong>
          <span>${escapeHtml(capacity)}</span>
          ${codexLegend}
        </div>
      </article>`;
    }).join("");
    // CSP style-src 'self' strips inline style="--tank-size", so scale via CSSOM + data-*.
    gallery.querySelectorAll(".usage-pool-tank").forEach((tank) => {
      const scale = Number(tank.dataset.tankScale);
      if (scale > 0) tank.style.setProperty("--tank-scale", String(scale));
    });
  }
}

function renderOrb(d) {
  const displayMode = ["quota", "speed", "pool"].includes(settings.orbDisplayMode) ? settings.orbDisplayMode : "quota";
  const pools = orbPools(d, displayMode);
  const selected = selectedQuotaPool(pools);
  const ring = $("orbRing");
  renderOrbResets(d);
  document.querySelectorAll("[data-orb-display]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orbDisplay === displayMode);
  });
  $("orbRefreshBtn").classList.toggle("spinning", Boolean(snapshot.loading));
  $("orbPrevBtn").disabled = displayMode === "pool" || pools.length < 2;
  $("orbNextBtn").disabled = displayMode === "pool" || pools.length < 2;
  if (displayMode === "pool") renderUsagePoolGallery(pools);
  if (!selected) {
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
  const normalEnd = normalPoints;
  const fastEnd = Math.min(selected.used, normalEnd + fastPoints);
  ring.style.setProperty("--pool-scale", String(selected.sizeScale || 1));
  ring.style.setProperty("--pool-size", `${(126 * (selected.sizeScale || 1)).toFixed(1)}px`);
  ring.style.setProperty("--orb-used", selected.used.toFixed(2));
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
    ? `普通 ${pct(normalPoints)} · Fast ${pct(fastPoints)}${unknownPoints > 0.01 ? ` · 未知 ${pct(unknownPoints)}` : ""}`
    : displayMode === "pool"
      ? selected.source === "codex"
        ? `青色 5 小时可用 ${pct(selected.remaining)} · 蓝色仅周池 ${pct(selected.weeklyOnlyRemaining)}`
        : `水位 ${pct(selected.remaining)} · ${liquidCapacityText(selected)}`
      : `剩余 ${pct(selected.remaining)} · ${selected.detail}`;
  if (displayMode === "pool") {
    ensureLiquidAnimation(pools);
    for (const effect of pendingLiquidEffects.values()) triggerLiquidRefresh(effect);
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
    ? `<div class="recent-icon">↗</div><div><span>最近一次调用 · ${last.source === "codex" ? "Codex" : "Cursor"}</span><b>${settings.privacyMode ? "模型信息已隐藏" : `${escapeHtml(last.model)}${last.effort ? ` · ${escapeHtml(last.effort)}` : ""}`}</b><small>总 ${formatTokens(lastTotal)} Token · 有效 ${formatTokens(lastEffective)} · 写缓存 ${formatTokens(last.tokens?.cacheWrite)} / ${formatUsd(last.cacheWriteCostCents)} · 读缓存 ${formatTokens(last.tokens?.cacheRead)} / ${formatUsd(last.cacheReadCostCents)} · ${lastCost} · ${timeAgo(last.at)}</small></div>`
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
    .map((row, index) => {
      const modelLabel = settings.privacyMode ? `模型 ${String(index + 1).padStart(2, "0")}` : row.label;
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

function chartSvg(series, metric, range, breakdown = false, speedBreakdown = false) {
  if (!series?.length) return `<div class="empty-state">暂无趋势数据</div>`;
  const fullscreen = Boolean(windowState.fullscreen);
  const width = fullscreen ? 1400 : 400;
  const height = fullscreen ? 460 : 236;
  const left = fullscreen ? 76 : 45;
  const top = fullscreen ? 24 : 14;
  const plotWidth = fullscreen ? width - left - 28 : 344;
  const plotHeight = fullscreen ? height - top - 76 : 170;
  const baseY = top + plotHeight;
  const stacked = breakdown || speedBreakdown;
  const segmentDefs = chartSegmentDefinitions(metric, { breakdown, speedBreakdown });
  const segmentValue = (item, def) => (def.read ? def.read(item) : Number(item[def.key]) || 0);
  const values = series.map((item) => stacked
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
      if (!stacked) {
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
  const speedBreakdown = Boolean(settings.trendSpeedBreakdown);
  if (metric === "equivalentCostCents" && !view.costAvailable) metric = "total";
  if (breakdown && metric === "effective") metric = "total";
  const series = view.trends?.[range] || [];
  const total = series.reduce((sum, item) => sum + (Number(item[metric]) || 0), 0);
  const peak = series.reduce((best, item) => !best || (item[metric] || 0) > (best[metric] || 0) ? item : best, null);
  const resolution = range === "day" ? "今天 · 每小时聚合" : range === "week" ? "最近 7 天 · 每日聚合" : "最近 30 天 · 每日聚合";
  $("trendResolution").textContent = `${view.label || "全部"} · ${resolution}`;
  $("trendTotal").textContent = formatMetric(total, metric);
  hideChartTooltip();
  chartTooltipContext = { series, metric, breakdown, speedBreakdown };
  $("trendChart").innerHTML = chartSvg(series, metric, range, breakdown, speedBreakdown);
  $("legendItems").innerHTML = trendLegendHtml(metric, breakdown, speedBreakdown);
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

function trendLegendHtml(metric, breakdown, speedBreakdown) {
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
  const definitions = breakdown || speedBreakdown
    ? chartSegmentDefinitions(metric, { breakdown, speedBreakdown })
    : compositionSegmentDefinitions(metric);
  const parts = definitions.map((definition) => ({
    ...definition,
    value: Math.max(0, definition.read ? definition.read(item) : Number(item[definition.key]) || 0),
  })).filter((part) => !speedBreakdown || part.value > 0);
  const partTotal = parts.reduce((sum, part) => sum + part.value, 0);
  $("chartTooltip").classList.toggle("wide", Boolean(speedBreakdown && breakdown));
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
  document.body.classList.toggle("orb-pool-layout", orbMode && settings.orbDisplayMode === "pool");
  document.body.classList.toggle("privacy", Boolean(settings.privacyMode));
  document.body.classList.toggle("smart-docked", Boolean(windowState.smartDocked));
  $("compactBtn").classList.toggle("active", Boolean(settings.compact) && !windowState.fullscreen && !orbMode);
  $("compactBtn").disabled = Boolean(windowState.fullscreen);
  $("orbBtn").classList.toggle("active", orbMode);
  $("orbBtn").disabled = Boolean(windowState.fullscreen);
  $("fullscreenBtn").classList.toggle("active", Boolean(windowState.fullscreen));
  $("fullscreenBtn").textContent = windowState.fullscreen ? "↙" : "⛶";
  $("fullscreenBtn").title = windowState.fullscreen ? "退出全屏（Esc / F11）" : "全屏仪表盘（F11）";
  $("smartBtn").classList.toggle("active", smartPanelOpen || settings.smartDock || settings.privacyMode || settings.quotaAlerts);
  $("smartPanel").hidden = !smartPanelOpen || orbMode;
  $("smartDockToggle").checked = Boolean(settings.smartDock);
  $("privacyToggle").checked = Boolean(settings.privacyMode);
  $("alertToggle").checked = Boolean(settings.quotaAlerts);
  $("alertThresholdSelect").value = String(settings.alertThreshold || 20);
  $("alertThresholdSelect").disabled = !settings.quotaAlerts;
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
  $("planLine").textContent = settings.privacyMode ? "账户信息已隐藏 · 隐私模式" : accountParts.join(" · ") || "本机用量历史";
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

function setSmartPanel(open) {
  smartPanelOpen = Boolean(open);
  $("smartPanel").hidden = !smartPanelOpen || Boolean(settings.orbMode);
  $("smartBtn").classList.toggle("active", smartPanelOpen || settings.smartDock || settings.privacyMode || settings.quotaAlerts);
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
$("speedBreakdownBtn").addEventListener("click", () => {
  settings.trendSpeedBreakdown = !settings.trendSpeedBreakdown;
  window.widget.saveSettings({ trendSpeedBreakdown: settings.trendSpeedBreakdown });
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
$("smartBtn").addEventListener("click", () => setSmartPanel(!smartPanelOpen));
$("smartCloseBtn").addEventListener("click", () => setSmartPanel(false));
$("smartDockToggle").addEventListener("change", (event) => window.widget.saveSettings({ smartDock: event.target.checked }));
$("privacyToggle").addEventListener("change", (event) => window.widget.saveSettings({ privacyMode: event.target.checked }));
$("alertToggle").addEventListener("change", (event) => window.widget.saveSettings({ quotaAlerts: event.target.checked }));
$("alertThresholdSelect").addEventListener("change", (event) => window.widget.saveSettings({ alertThreshold: Number(event.target.value) }));
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
  recordLiquidSnapshot(next, true);
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
window.widget.onWindowMotion?.(handleWindowMotion);

window.addEventListener("keydown", (event) => {
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

setInterval(() => {
  renderStatus();
  if (settings.orbMode) renderOrb(snapshot.data);
}, 1000);
Promise.all([window.widget.getSettings(), window.widget.getSnapshot(), window.widget.getWindowState()]).then(([savedSettings, initialSnapshot, initialWindowState]) => {
  settings = { ...settings, ...savedSettings };
  recordLiquidSnapshot(initialSnapshot, false);
  snapshot = initialSnapshot;
  modelUsage = initialSnapshot.data?.modelUsage || null;
  windowState = { ...windowState, ...initialWindowState };
  render();
});
