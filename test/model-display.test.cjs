const test = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("../src/renderer/model-display.js");

test("friendly names normalize effort and Fast without duplicate suffixes", () => {
  assert.equal(format("cursor-grok-4.6-high-fast"), "Grok 4.6 - High - Fast");
  assert.equal(format("grok-4.5-xhigh"), "Grok 4.5 - Xhigh");
  assert.equal(format({model:"gpt-6-astra-high-fast", effort:"high", fast:true}), "GPT 6 Astra - High - Fast");
  assert.equal(format("grok-4.5-fast-xhigh"), "Grok 4.5 - Xhigh - Fast");
  assert.equal(format("claude-4.5-opus-high-thinking"), "Claude 4.5 Opus - High");
  assert.equal(format("claude-fable-5-1-thinking-high"), "Claude Fable 5.1 - High");
  assert.equal(format("grok-code-fast-1"), "Grok Code Fast 1");
  assert.equal(format("DeepSeek-V4 pro"), "DeepSeek V4 Pro");
  assert.equal(format("GLM-5.2"), "GLM 5.2");
  assert.equal(format("unknown"), "未知模型");
});

test("display precision hides effort and speed without changing raw data", () => {
  const row = {model:"gpt-6-astra-high-fast", effort:"xhigh", fast:true};
  assert.equal(format(row, {precision:"coarse"}), "GPT 6 Astra");
  assert.equal(format(row, {precision:"speed"}), "GPT 6 Astra - Fast");
  assert.equal(format(row), "GPT 6 Astra - Xhigh - Fast");
  assert.equal(row.model, "gpt-6-astra-high-fast");
  assert.equal(format({...row, fastKnown:false}), "GPT 6 Astra - Xhigh - 速度未知");
  assert.equal(format({...row, fast:false}), "GPT 6 Astra - Xhigh");
});
