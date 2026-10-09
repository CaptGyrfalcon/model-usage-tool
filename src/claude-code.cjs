const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Claude Code writes one JSONL transcript per session under <config>/projects.
// Only local transcripts are read; no credentials or remote endpoints are used.
function claudeConfigDirs() {
  const configured = String(process.env.CLAUDE_CONFIG_DIR || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const dirs = configured.length ? configured : [
    path.join(os.homedir(), ".config", "claude"),
    path.join(os.homedir(), ".claude"),
  ];
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function claudeProjectDirs() {
  return claudeConfigDirs().map((dir) => path.join(dir, "projects")).filter((dir) => fs.existsSync(dir));
}

function walkJsonl(root, output = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(file, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(file);
  }
  return output;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

const CLAUDE_EVENT_KEY_PREFIX = "claude:";
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// One API response is split into several transcript lines that repeat the same
// usage block, so the response identity (message id + request id) is the key.
function claudeEventKey(record) {
  const messageId = record?.message?.id;
  if (!messageId) return null;
  return `${CLAUDE_EVENT_KEY_PREFIX}${messageId}:${record.requestId || ""}`;
}

function eventFromRecord(record) {
  if (record?.type !== "assistant") return null;
  const message = record.message || {};
  const usage = message.usage;
  const model = String(message.model || "");
  if (!usage || !model || model === "<synthetic>") return null;
  const eventKey = claudeEventKey(record);
  const timestamp = Date.parse(record.timestamp);
  if (!eventKey || !Number.isFinite(timestamp)) return null;
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  const cacheRead = number(usage.cache_read_input_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  const split = usage.cache_creation || {};
  const cacheWrite1h = Math.min(cacheWrite, number(split.ephemeral_1h_input_tokens));
  const speed = String(usage.speed || "").toLowerCase();
  const effort = String(record.effort || "").toLowerCase();
  return {
    source: "claude",
    eventKey,
    timestamp,
    model,
    effort: EFFORT_LEVELS.has(effort) ? effort : null,
    fast: speed === "fast",
    fastKnown: Boolean(speed),
    serviceTier: usage.service_tier ? String(usage.service_tier) : null,
    tierSource: speed ? "response" : null,
    pool: "claude",
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    // Output tokens already include thinking; this is only a breakdown.
    reasoning: number(usage.output_tokens_details?.thinking_tokens),
    costCents: null,
    count: 1,
    sessionId: record.sessionId || null,
    sidechain: Boolean(record.isSidechain),
  };
}

class ClaudeCodeScanner {
  constructor(roots = claudeProjectDirs()) {
    this.roots = roots;
    this.fileStates = new Map();
    this.scanErrors = [];
  }

  files() {
    return [...new Set(this.roots.flatMap((root) => walkJsonl(root)))];
  }

  // Returns only events first seen in this pass; history keeps the rest.
  scan() {
    this.scanErrors = [];
    const files = this.files();
    const present = new Set(files);
    const events = new Map();
    for (const file of files) {
      try {
        this.scanFile(file, events);
      } catch (error) {
        this.scanErrors.push({ path: file, error: error.message });
      }
    }
    for (const file of this.fileStates.keys()) {
      if (!present.has(file)) this.fileStates.delete(file);
    }
    return {
      available: this.roots.length > 0,
      roots: this.roots,
      events: [...events.values()],
      scanErrors: this.scanErrors,
      files: files.length,
    };
  }

  scanFile(file, events) {
    const stat = fs.statSync(file);
    let state = this.fileStates.get(file);
    if (!state || stat.size < state.offset) state = { offset: 0, remainder: "" };
    if (stat.size === state.offset) {
      this.fileStates.set(file, state);
      return;
    }
    const byteLength = stat.size - state.offset;
    const buffer = Buffer.allocUnsafe(byteLength);
    const handle = fs.openSync(file, "r");
    try {
      fs.readSync(handle, buffer, 0, byteLength, state.offset);
    } finally {
      fs.closeSync(handle);
    }
    state.offset = stat.size;
    const lines = `${state.remainder}${buffer.toString("utf8")}`.split(/\r?\n/);
    state.remainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const event = eventFromRecord(record);
      // The first line of a response can carry a partial usage block; keep the largest.
      const existing = event && events.get(event.eventKey);
      if (event && (!existing || event.output >= existing.output)) events.set(event.eventKey, event);
    }
    this.fileStates.set(file, state);
  }
}

let singleton;

function scanClaudeUsage() {
  if (!singleton) singleton = new ClaudeCodeScanner();
  return singleton.scan();
}

module.exports = {
  CLAUDE_EVENT_KEY_PREFIX,
  ClaudeCodeScanner,
  claudeConfigDirs,
  claudeEventKey,
  claudeProjectDirs,
  eventFromRecord,
  scanClaudeUsage,
};
