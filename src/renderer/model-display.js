(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ModelDisplay = api;
})(typeof window === "object" ? window : globalThis, function () {
  const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const words = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", api: "API", ai: "AI" };
  const capitalize = (word) => words[word.toLowerCase()] || word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  function descriptor(raw) {
    const parts = String(raw || "unknown").replace(/^cursor-/i, "").split(/[-_\s]+/).filter(Boolean);
    let effort = null, fast = false, thinking = false;
    while (parts.length > 1) {
      const last = parts.at(-1).toLowerCase();
      if (efforts.has(last)) { parts.pop(); effort ||= last; }
      else if (last === "fast") { fast = true; parts.pop(); }
      else if (last === "thinking") { thinking = true; parts.pop(); }
      else break;
    }
    const base = parts.join("-");
    const aliases = { unknown: "未知模型", default: "Auto", auto: "Auto" };
    const name = aliases[base.toLowerCase()] || base.replace(/(\d)-(\d)(?=-|$)/g, "$1.$2")
      .split("-").map(capitalize).join(" ");
    return { name, effort, fast, thinking };
  }
  function format(value, { precision = "exact", showSpeed = true, explicitStandard = false } = {}) {
    const row = typeof value === "string" ? { model: value } : value || {};
    const parsed = descriptor(row.model || row.name || row.base || row.label);
    const effort = row.effort || parsed.effort;
    const parts = [parsed.name];
    if (precision === "exact") {
      if (effort) parts.push(capitalize(String(effort)));
      else if (parsed.thinking) parts.push("Thinking");
    }
    if (precision !== "coarse" && showSpeed) {
      if (row.fastKnown === false) parts.push("速度未知");
      else if (row.fast ?? parsed.fast) parts.push("Fast");
      else if (explicitStandard) parts.push("非 Fast");
    }
    return parts.join(" - ");
  }
  return { descriptor, format, effort: (value) => value ? capitalize(String(value)) : "" };
});
