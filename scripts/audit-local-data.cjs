const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function walkJsonl(root, output = []) {
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(file, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(file);
  }
  return output;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function auditCodex() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const files = [
    ...walkJsonl(path.join(home, "sessions")),
    ...walkJsonl(path.join(home, "archived_sessions")),
  ];
  const usageKeys = new Map();
  const detailKeys = new Map();
  const otherUsageLocations = new Map();
  let tokenRows = 0;
  let flatWritePositive = 0;
  let nestedWritePositive = 0;
  let rowsContainingCacheWriteLiteral = 0;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (line.includes("cache_write")) rowsContainingCacheWriteLiteral += 1;
      const payload = record.payload || {};
      if (record.type === "event_msg" && payload.type === "token_count") {
        const usage = payload.info?.last_token_usage;
        if (usage) {
          tokenRows += 1;
          for (const key of Object.keys(usage)) increment(usageKeys, key);
          for (const [name, details] of [
            ["input_tokens_details", usage.input_tokens_details],
            ["prompt_tokens_details", usage.prompt_tokens_details],
          ]) {
            if (!details || typeof details !== "object") continue;
            for (const key of Object.keys(details)) increment(detailKeys, `${name}.${key}`);
          }
          const flatWrite = Number(
            usage.cache_write_input_tokens
            || usage.cache_write_tokens
            || usage.input_cache_write_tokens
            || 0
          );
          const nestedWrite = Number(
            usage.input_tokens_details?.cache_write_tokens
            || usage.prompt_tokens_details?.cache_write_tokens
            || 0
          );
          if (flatWrite > 0) flatWritePositive += 1;
          if (nestedWrite > 0) nestedWritePositive += 1;
        }
      }
      for (const [name, usage] of [
        ["payload.response.usage", payload.response?.usage],
        ["payload.info.response.usage", payload.info?.response?.usage],
        ["payload.usage", payload.usage],
        ["record.response.usage", record.response?.usage],
      ]) {
        if (usage && JSON.stringify(usage).includes("cache_write")) increment(otherUsageLocations, name);
      }
    }
  }
  return {
    files: files.length,
    tokenRows,
    usageKeys: Object.fromEntries([...usageKeys].sort()),
    detailKeys: Object.fromEntries([...detailKeys].sort()),
    flatWritePositive,
    nestedWritePositive,
    rowsContainingCacheWriteLiteral,
    otherUsageLocations: Object.fromEntries(otherUsageLocations),
  };
}

function auditCursor() {
  const dbPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "cursor-usage-widget",
    "usage-history.sqlite"
  );
  if (!fs.existsSync(dbPath)) return { available: false, path: dbPath };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT event_key, timestamp, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, equivalent_cost_cents
      FROM usage_events WHERE source = 'cursor'
    `).all();
    const groups = new Map();
    for (const row of rows) {
      const parts = String(row.event_key).split("|");
      const identity = parts.slice(0, 3).join("|");
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push(row);
    }
    const repeated = [...groups.values()].filter((group) => group.length > 1);
    const sumCost = (items) => items.reduce((sum, row) => sum + Number(row.equivalent_cost_cents || 0), 0);
    const maxCost = (items) => Math.max(...items.map((row) => Number(row.equivalent_cost_cents || 0)));
    return {
      available: true,
      path: dbPath,
      rows: rows.length,
      repeatedGroups: repeated.length,
      repeatedRows: repeated.reduce((sum, group) => sum + group.length, 0),
      extraRows: repeated.reduce((sum, group) => sum + group.length - 1, 0),
      estimatedOvercountCents: repeated.reduce((sum, group) => sum + sumCost(group) - maxCost(group), 0),
      groupSizes: repeated.map((group) => group.length).sort((a, b) => b - a).slice(0, 20),
    };
  } finally {
    db.close();
  }
}

console.log(JSON.stringify({ cursor: auditCursor(), codex: auditCodex() }, null, 2));
