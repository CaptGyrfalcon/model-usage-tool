(function exposeLiquidPool(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LiquidPool = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));

  function capacityOf(pool) {
    const candidates = [
      pool?.capacityCents,
      pool?.quotaEstimate?.packageTotalCents,
      pool?.quotaEstimate?.inferredTotalCents,
      pool?.includedCents?.limit,
    ];
    const value = candidates.map(Number).find((candidate) => Number.isFinite(candidate) && candidate > 0);
    return value || null;
  }

  function codexPool(windows, fallbackCapacity = null) {
    const listed = (Array.isArray(windows) ? windows : [])
      .filter(Boolean)
      .slice()
      .sort((a, b) => (Number(a.windowMinutes) || Infinity) - (Number(b.windowMinutes) || Infinity));
    if (!listed.length) return null;
    const short = listed[0];
    const long = listed[listed.length - 1];
    const shortRemaining = clamp(short.percentRemaining ?? (100 - Number(short.usedPercent)));
    const weeklyRemaining = clamp(long.percentRemaining ?? (100 - Number(long.usedPercent)));
    const weeklyCapacityCents = capacityOf(long) || Number(fallbackCapacity) || null;
    const shortCapacityCents = capacityOf(short);
    // Both colors share the weekly tank. Scale the 5-hour remaining percent by
    // the actual inferred capacity ratio, not a fixed quarter of the week.
    const share = shortCapacityCents && weeklyCapacityCents
      ? Math.min(1, shortCapacityCents / weeklyCapacityCents)
      : listed.length === 1 && weeklyCapacityCents ? 1 : null;
    const immediateRemaining = share == null
      ? (listed.length === 1 ? shortRemaining : 0)
      : Math.min(shortRemaining * share, weeklyRemaining);
    const weeklyOnlyRemaining = Math.max(0, weeklyRemaining - immediateRemaining);
    return {
      id: "codex-combined",
      source: "codex",
      name: listed.length > 1 ? "Codex 联合池" : `Codex · ${short.name || "额度池"}`,
      used: 100 - weeklyRemaining,
      remaining: immediateRemaining,
      weeklyRemaining,
      weeklyOnlyRemaining,
      shortRemaining,
      capacityCents: weeklyCapacityCents,
      shortCapacityCents,
      usedCents: Number(long?.quotaEstimate?.usedCents) || null,
      capacityEstimated: true,
      precision: 2,
      detail: listed.length > 1
        ? `5 小时可用 ${shortRemaining.toFixed(2)}% · 仅周池可用 ${weeklyOnlyRemaining.toFixed(2)}%`
        : `当前可用 ${shortRemaining.toFixed(2)}%`,
    };
  }

  const TANK_SHAPES = [
    { id: "sphere", label: "球形" },
    { id: "flask", label: "锥形瓶" },
    { id: "cube", label: "正方体泳池" },
    { id: "cylinder", label: "量筒" },
    { id: "beaker", label: "烧杯" },
    { id: "bowl", label: "碗池" },
  ];
  const TANK_SHAPE_IDS = new Set(TANK_SHAPES.map((shape) => shape.id));

  function normalizeTankShape(value) {
    return TANK_SHAPE_IDS.has(value) ? value : "sphere";
  }

  function sizeScales(pools) {
    const capacities = pools.map(capacityOf).filter(Boolean);
    const maximum = capacities.length ? Math.max(...capacities) : null;
    return pools.map((pool) => {
      const capacity = capacityOf(pool);
      if (!maximum || !capacity) return 1;
      // Uniform scale of any vessel: volume follows linear size cubed.
      return Math.cbrt(capacity / maximum);
    });
  }

  function mapTankPoint(nx, ny, width, height, inset) {
    const sx = Math.max(0.55, 1 - (2 * inset) / Math.max(width, 1));
    const sy = Math.max(0.55, 1 - (2 * inset) / Math.max(height, 1));
    return [width / 2 + (nx - 0.5) * width * sx, height / 2 + (ny - 0.5) * height * sy];
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function traceTankShape(ctx, width, height, shape, inset = 0) {
    const pt = (nx, ny) => mapTankPoint(nx, ny, width, height, inset);
    ctx.beginPath();
    switch (normalizeTankShape(shape)) {
      case "cube": {
        const [x, y] = pt(0.07, 0.07);
        const [right, bottom] = pt(0.93, 0.93);
        roundedRectPath(ctx, x, y, right - x, bottom - y, Math.min(width, height) * 0.1);
        break;
      }
      case "cylinder": {
        const [left, top] = pt(0.29, 0.05);
        const [right, bottom] = pt(0.71, 0.96);
        const rx = (right - left) / 2;
        const cx = (left + right) / 2;
        const cap = Math.min(6, rx * 0.2, (bottom - top) * 0.05);
        ctx.moveTo(left, top + cap);
        ctx.ellipse(cx, top + cap, rx, cap, 0, Math.PI, 0);
        ctx.lineTo(right, bottom - cap);
        ctx.ellipse(cx, bottom - cap, rx, cap, 0, 0, Math.PI);
        ctx.closePath();
        break;
      }
      case "flask": {
        ctx.moveTo(...pt(0.405, 0.035));
        ctx.lineTo(...pt(0.595, 0.035));
        ctx.quadraticCurveTo(...pt(0.62, 0.05), ...pt(0.615, 0.195));
        ctx.lineTo(...pt(0.88, 0.76));
        ctx.lineTo(...pt(0.88, 0.915));
        ctx.quadraticCurveTo(...pt(0.86, 0.96), ...pt(0.5, 0.965));
        ctx.quadraticCurveTo(...pt(0.14, 0.96), ...pt(0.12, 0.915));
        ctx.lineTo(...pt(0.12, 0.76));
        ctx.lineTo(...pt(0.385, 0.195));
        ctx.quadraticCurveTo(...pt(0.38, 0.05), ...pt(0.405, 0.035));
        ctx.closePath();
        break;
      }
      case "beaker": {
        ctx.moveTo(...pt(0.18, 0.145));
        ctx.lineTo(...pt(0.76, 0.145));
        ctx.quadraticCurveTo(...pt(0.91, 0.12), ...pt(0.945, 0.165));
        ctx.lineTo(...pt(0.86, 0.23));
        ctx.lineTo(...pt(0.835, 0.875));
        ctx.quadraticCurveTo(...pt(0.81, 0.96), ...pt(0.5, 0.97));
        ctx.quadraticCurveTo(...pt(0.19, 0.96), ...pt(0.165, 0.875));
        ctx.lineTo(...pt(0.18, 0.145));
        ctx.closePath();
        break;
      }
      case "bowl": {
        ctx.moveTo(...pt(0.07, 0.40));
        ctx.lineTo(...pt(0.93, 0.40));
        ctx.bezierCurveTo(...pt(0.99, 0.54), ...pt(0.90, 0.86), ...pt(0.5, 0.97));
        ctx.bezierCurveTo(...pt(0.10, 0.86), ...pt(0.01, 0.54), ...pt(0.07, 0.40));
        ctx.closePath();
        break;
      }
      default: {
        const [cx, cy] = pt(0.5, 0.5);
        const [rx] = pt(1, 0.5);
        const [, ry] = pt(0.5, 1);
        ctx.ellipse(cx, cy, Math.abs(rx - cx), Math.abs(ry - cy), 0, 0, Math.PI * 2);
      }
    }
  }

  function clipTankShape(ctx, width, height, shape, inset = 5) {
    if (!ctx) return;
    traceTankShape(ctx, width, height, shape, inset);
    ctx.clip();
  }

  const LAYER_TONES = {
    "cursor-models": {
      id: "cursor-models",
      swatch: "#4ce2ba",
      top: "rgba(76, 226, 186, 0.94)",
      bottom: "rgba(22, 126, 132, 0.98)",
      phase: 0,
      amplitude: 1.05,
    },
    "cursor-api": {
      id: "cursor-api",
      swatch: "#e8b86d",
      top: "rgba(232, 184, 109, 0.94)",
      bottom: "rgba(156, 92, 36, 0.96)",
      phase: 0.7,
      amplitude: 0.92,
    },
    "codex-weekly": {
      id: "codex-weekly",
      swatch: "#7a89ff",
      top: "rgba(122, 137, 255, 0.92)",
      bottom: "rgba(58, 75, 176, 0.96)",
      phase: 1.8,
      amplitude: 0.75,
    },
    "codex-immediate": {
      id: "codex-immediate",
      swatch: "#5fd4e8",
      top: "rgba(95, 212, 232, 0.94)",
      bottom: "rgba(24, 118, 148, 0.96)",
      phase: 1.1,
      amplitude: 0.88,
    },
  };

  function layerTone(id) {
    return LAYER_TONES[id] || LAYER_TONES["cursor-models"];
  }

  function remainingCentsOf(pool, percent) {
    const capacity = Number(pool?.capacityCents);
    const ratio = clamp(percent) / 100;
    if (Number.isFinite(capacity) && capacity > 0) return ratio * capacity;
    return ratio;
  }

  function combinedTank(pools) {
    const listed = (Array.isArray(pools) ? pools : []).filter(Boolean);
    const layers = [];
    const pushLayer = (id, name, tone, cents) => {
      layers.push({
        ...layerTone(tone),
        id,
        name,
        tone,
        remainingCents: Math.max(0, Number(cents) || 0),
      });
    };
    for (const pool of listed) {
      if (pool.source === "codex") {
        pushLayer(`${pool.id}-weekly`, "Codex 周池", "codex-weekly", remainingCentsOf(pool, pool.weeklyOnlyRemaining));
        pushLayer(`${pool.id}-immediate`, "Codex 5 小时", "codex-immediate", remainingCentsOf(pool, pool.remaining));
        continue;
      }
      const tone = pool.id === "cursor-api" ? "cursor-api" : "cursor-models";
      const name = pool.id === "cursor-api"
        ? "三方模型"
        : String(pool.name || "Cursor 模型").replace(/池$/, "");
      pushLayer(pool.id, name, tone, remainingCentsOf(pool, pool.remaining));
    }
    const totalCapacity = listed.reduce((sum, pool) => {
      const capacity = Number(pool.capacityCents);
      return sum + (Number.isFinite(capacity) && capacity > 0 ? capacity : 0);
    }, 0);
    const weightTotal = totalCapacity > 0
      ? totalCapacity
      : Math.max(1, layers.reduce((sum, layer) => sum + layer.remainingCents, 0));
    let cumulative = 0;
    const stacked = layers.map((layer) => {
      const share = weightTotal > 0 ? layer.remainingCents / weightTotal * 100 : 0;
      cumulative += share;
      return { ...layer, share, level: cumulative };
    });
    const remainingCents = stacked.reduce((sum, layer) => sum + layer.remainingCents, 0);
    return {
      id: "usage-combined",
      name: "总用量池",
      source: "combined",
      remaining: cumulative,
      remainingCents,
      capacityCents: totalCapacity || null,
      capacityEstimated: true,
      precision: 2,
      layers: stacked,
      sizeScale: 1,
    };
  }

  function damageParts(cents) {
    const dollars = Math.max(0, Number(cents) || 0) / 100;
    const [integer, fraction] = dollars.toFixed(4).split(".");
    return { major: `-$${integer}.${fraction.slice(0, 2)}`, minor: fraction.slice(2) };
  }

  function remainingDrop(previous, pool, key) {
    return Math.max(0, (Number(previous?.[key]) || 0) - (Number(pool?.[key]) || 0));
  }

  const MIN_DRAIN_MS = 900;
  const MIN_SPEND_CENTS = 5;
  const MAX_SPEND_CENTS = 200;

  function refreshEffectDuration(amountCents, intervalMs = 30_000) {
    const minMs = MIN_DRAIN_MS;
    const cycleMs = Math.max(minMs, Number(intervalMs) || 30_000);
    const cents = Math.max(0, Number(amountCents) || 0);
    if (cents <= MIN_SPEND_CENTS) return minMs;
    if (cents >= MAX_SPEND_CENTS) return cycleMs;
    const progress = (cents - MIN_SPEND_CENTS) / (MAX_SPEND_CENTS - MIN_SPEND_CENTS);
    return Math.round(minMs + progress * (cycleMs - minMs));
  }

  function refreshSpend(previous, pool) {
    if (!previous || !pool) return null;
    const levelDelta = Math.max(remainingDrop(previous, pool, "remaining"), remainingDrop(previous, pool, "weeklyRemaining"));
    const previousUsed = Number(previous.usedCents);
    const nextUsed = Number(pool.usedCents);
    const exactDelta = Number.isFinite(previousUsed) && Number.isFinite(nextUsed)
      ? Math.max(0, nextUsed - previousUsed)
      : null;
    const estimatedDelta = levelDelta > 0 && Number(pool.capacityCents) > 0
      ? levelDelta * Number(pool.capacityCents) / 100
      : 0;
    const amountCents = exactDelta == null ? estimatedDelta : exactDelta;
    if (!(amountCents > 0)) return null;
    return { amountCents, levelDelta };
  }

  return {
    LAYER_TONES,
    TANK_SHAPES,
    capacityOf,
    clamp,
    clipTankShape,
    codexPool,
    combinedTank,
    damageParts,
    layerTone,
    normalizeTankShape,
    refreshEffectDuration,
    refreshSpend,
    sizeScales,
    traceTankShape,
  };
});
