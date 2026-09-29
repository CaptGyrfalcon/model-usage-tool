(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./model-display.js"));
  else root.ReceiptModel = factory(root.ModelDisplay);
})(typeof window === "object" ? window : globalThis, function (ModelDisplay) {
  const titles = { day: "每日 AI 对账单", week: "每周 AI 对账单", month: "每月 AI 对账单", year: "年度 AI 对账单" };
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function provider(model) {
    const m = String(model || "").toLowerCase();
    if (/claude/.test(m)) return "anthropic";
    if (/grok/.test(m)) return "grok";
    if (/gpt|^o[134](?:-|$)|codex/.test(m)) return "openai";
    if (/gemini/.test(m)) return "gemini";
    if (/gemma/.test(m)) return "gemma";
    if (/deepseek/.test(m)) return "deepseek";
    if (/chatglm|glm|zhipu|z-ai|zai\//.test(m)) return "zai";
    if (/qwen|qwq/.test(m)) return "qwen";
    if (/mistral|codestral|devstral|ministral|pixtral|magistral/.test(m)) return "mistral";
    if (/llama/.test(m)) return "meta";
    if (/minimax/.test(m)) return "minimax";
    if (/kimi|moonshot/.test(m)) return "moonshot";
    if (/composer|^(?:cursor-)?(?:auto|default)(?:-|$)/.test(m)) return "cursor";
    return null;
  }
  function defaults(period) {
    if (!Object.hasOwn(titles, period)) throw new Error("账单周期无效");
    return { splitEffort: period === "day", splitSpeed: period === "day" || period === "week" };
  }
  const providerNames = { openai: "OpenAI", anthropic: "Anthropic", cursor: "Cursor", grok: "xAI", zai: "Z.ai",
    gemini: "Google", gemma: "Google", deepseek: "DeepSeek", qwen: "Alibaba", mistral: "Mistral", meta: "Meta", minimax: "MiniMax", moonshot: "Moonshot" };
  const effortOrder = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none", "unknown"];
  const tierOrder = { astra: 0, sol: 1, terra: 2, luna: 3, opus: 0, sonnet: 1, haiku: 2,
    ultra: 0, pro: 1, flash: 2, lite: 3, large: 0, medium: 1, small: 2, mini: 3, nano: 4 };
  const compareText = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  function modelSortKey(row) {
    const name = ModelDisplay.descriptor(row.model).name;
    const version = (name.match(/\d+(?:\.\d+)*/)?.[0] || "").split(".").filter(Boolean).map(Number);
    const tier = name.toLowerCase().split(/\s+/).find((word) => Object.hasOwn(tierOrder, word));
    return { name, version, tier: tier ? tierOrder[tier] : 99, provider: providerNames[provider(row.model)] || "~" };
  }
  function compareModels(a, b) {
    const ak = modelSortKey(a), bk = modelSortKey(b);
    let difference = compareText(a.source, b.source) || compareText(ak.provider, bk.provider);
    if (difference) return difference;
    for (let i = 0; i < Math.max(ak.version.length, bk.version.length); i++) {
      difference = (bk.version[i] || 0) - (ak.version[i] || 0);
      if (difference) return difference;
    }
    difference = ak.tier - bk.tier || compareText(ak.name, bk.name);
    if (difference) return difference;
    const speedRank = (row) => row.sortSpeed === "fast" ? 0 : 1;
    const effortRank = (row) => { const index = effortOrder.indexOf(row.sortEffort); return index < 0 ? effortOrder.length : index; };
    return speedRank(a) - speedRank(b) || effortRank(a) - effortRank(b) || compareText(a.label, b.label);
  }
  function range(date, period = "day") {
    defaults(period);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("请选择有效日期");
    const [year, month, day] = date.split("-").map(Number);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error("日期无效");
    if (period === "week") start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    if (period === "month") start.setDate(1);
    if (period === "year") start.setMonth(0, 1);
    const end = new Date(start);
    if (period === "year") end.setFullYear(end.getFullYear() + 1);
    else if (period === "month") end.setMonth(end.getMonth() + 1);
    else end.setDate(end.getDate() + (period === "week" ? 7 : 1));
    const last = new Date(end); last.setDate(last.getDate() - 1);
    const label = period === "day" ? `${year}年${month}月${day}日`
      : period === "month" ? `${year}年${month}月`
      : period === "year" ? `${year}年` : `${localDate(start)} — ${localDate(last)}`;
    return { start: +start, end: +end, label, title: titles[period], key: localDate(start) };
  }
  function build(rows, { date, period = "day", source = "all", ...options }, generatedAt = Date.now()) {
    const bounds = range(date, period);
    const flags = { ...defaults(period), sort: "cost", ...options };
    if (!["cost", "model"].includes(flags.sort)) throw new Error("排序方式无效");
    const groups = new Map();
    for (const row of rows) {
      const parsed = ModelDisplay.descriptor(row.model);
      const isAuto = parsed.name.toLowerCase() === "auto";
      const splitEffort = flags.splitEffort && !isAuto && !/^composer(?:\s|$)/i.test(parsed.name);
      const splitSpeed = flags.splitSpeed && !isAuto;
      const effort = String(row.effort || parsed.effort || (parsed.thinking ? "thinking" : "unknown")).toLowerCase();
      const speed = row.fast === true || row.fast === 1 ? "fast"
        : row.fast === false || row.fast === 0 ? "standard" : parsed.fast ? "fast" : "standard";
      const key = JSON.stringify([row.source, parsed.name.toLowerCase(), splitEffort ? effort : null, splitSpeed ? speed : null]);
      if (!groups.has(key)) {
        const label = [parsed.name];
        if (splitEffort) label.push(effort === "unknown" ? "思考程度未知" : ModelDisplay.effort(effort));
        if (splitSpeed) label.push(speed === "fast" ? "Fast" : "non-fast");
        groups.set(key, { source: row.source, model: row.model, label: label.join(" · "),
          sortSpeed: splitSpeed ? speed : null, sortEffort: splitEffort ? effort : null,
          count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: 0, costCents: null });
      }
      const group = groups.get(key);
      for (const key of ["count", "input", "output", "cacheRead", "cacheWrite", "unpriced"]) group[key] += Number(row[key]) || 0;
      if (row.costCents != null) group.costCents = (group.costCents || 0) + row.costCents;
    }
    return { date, period, source, ...flags, range: bounds, generatedAt,
      rows: [...groups.values()].sort(flags.sort === "model" ? compareModels
        : (a, b) => (b.costCents || 0) - (a.costCents || 0) || a.label.localeCompare(b.label)) };
  }
  // Filtering is presentation-only: keep every row for request and usage totals.
  function detailRows(rows) {
    return rows.filter((row) => ModelDisplay.descriptor(row.model).name !== "未知模型");
  }
  return { defaults, range, build, provider, detailRows };
});
