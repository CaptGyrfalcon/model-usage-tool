const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function codexHomePath() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function walkJsonl(root, output = []) {
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(file, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(file);
  }
  return output;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function codexPlanName(planType) {
  const plan = String(planType || "").trim().toLowerCase();
  if (!plan) return "Codex";
  if (plan === "prolite") return "Pro 5×";
  return plan[0].toUpperCase() + plan.slice(1);
}

const CODEX_EVENT_KEY_PREFIX = "codex:v2:";

function cumulativeEventKey(sessionId, cumulative) {
  if (!cumulative) return null;
  const input = number(cumulative.input_tokens);
  const cached = number(cumulative.cached_input_tokens);
  const output = number(cumulative.output_tokens);
  const total = number(cumulative.total_tokens) || input + output;
  if (!input && !output && !total) return null;
  return `${CODEX_EVENT_KEY_PREFIX}${sessionId}:${input}:${cached}:${output}:${total}`;
}

function collapseCumulativeEvents(events) {
  const collapsed = new Map();
  const tierRank = (event) => event.tierSource === "response" ? 3 : event.tierSource ? 2 : 1;
  for (const event of events) {
    const existing = collapsed.get(event.eventKey);
    if (!existing) {
      collapsed.set(event.eventKey, {
        ...event,
        legacyEventKeys: event.legacyEventKey ? [event.legacyEventKey] : [],
      });
      continue;
    }
    if (event.legacyEventKey && !existing.legacyEventKeys.includes(event.legacyEventKey)) {
      existing.legacyEventKeys.push(event.legacyEventKey);
    }
    if (event.timestamp < existing.timestamp) existing.timestamp = event.timestamp;
    if (tierRank(event) > tierRank(existing)) {
      existing.fast = event.fast;
      existing.fastKnown = event.fastKnown;
      existing.serviceTier = event.serviceTier;
      existing.tierSource = event.tierSource;
    }
  }
  return [...collapsed.values()];
}

function rateWindow(raw) {
  if (!raw || !Number.isFinite(Number(raw.window_minutes))) return null;
  return {
    usedPercent: number(raw.used_percent),
    percentRemaining: Math.max(0, 100 - number(raw.used_percent)),
    windowMinutes: number(raw.window_minutes),
    resetsAt: raw.resets_at == null ? null : number(raw.resets_at) * 1000,
  };
}

function isMainCodexRateLimit(rateLimits, model = "") {
  const limitId = String(rateLimits?.limit_id || "").trim().toLowerCase();
  const limitName = String(rateLimits?.limit_name || "").trim().toLowerCase();
  // Account-wide Spark updates can appear in a non-Spark model's session.
  // Its internal pool ID does not contain the public model name.
  return !/spark|bengalfox/i.test(`${model} ${limitId} ${limitName}`)
    && !/base_model_inference|gpt-reserve/i.test(`${limitId} ${limitName}`);
}

function responseHeader(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(body || "").match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`, "i"))?.[1] ?? null;
}

function numberHeader(body, name) {
  const value = responseHeader(body, name);
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function headerRateWindow(body, slot, timestampSeconds) {
  const prefix = `x-codex-${slot}`;
  const windowMinutes = numberHeader(body, `${prefix}-window-minutes`);
  const usedPercent = numberHeader(body, `${prefix}-used-percent`);
  if (windowMinutes == null || usedPercent == null) return null;
  const resetAt = numberHeader(body, `${prefix}-reset-at`);
  const resetAfter = numberHeader(body, `${prefix}-reset-after-seconds`);
  const resetsAt = resetAt != null
    ? resetAt * 1000
    : resetAfter != null ? (timestampSeconds + resetAfter) * 1000 : null;
  return {
    usedPercent,
    percentRemaining: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt,
  };
}

function rateLimitFromResponseHeaders(body, timestampSeconds) {
  const activeLimit = responseHeader(body, "x-codex-active-limit");
  if (!isMainCodexRateLimit({ limit_id: activeLimit })) return null;
  const primary = headerRateWindow(body, "primary", timestampSeconds);
  const secondary = headerRateWindow(body, "secondary", timestampSeconds);
  if (!primary && !secondary) return null;
  const boolHeader = (name) => responseHeader(body, name)?.toLowerCase() === "true";
  const planType = responseHeader(body, "x-codex-plan-type");
  return {
    timestamp: Number(timestampSeconds) * 1000,
    limitId: responseHeader(body, "x-codex-active-limit"),
    primary,
    secondary,
    windows: [
      primary ? { slot: "primary", ...primary } : null,
      secondary ? { slot: "secondary", ...secondary } : null,
    ].filter(Boolean),
    credits: {
      has_credits: boolHeader("x-codex-credits-has-credits"),
      unlimited: boolHeader("x-codex-credits-unlimited"),
      balance: responseHeader(body, "x-codex-credits-balance"),
    },
    planType,
  };
}

function mergeRateLimitSnapshots(snapshots, maxAgeMs = 8 * 86_400_000) {
  const ordered = snapshots
    .filter(Boolean)
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  if (!ordered.length) return null;
  const newest = ordered[0];
  const shortEvidence = ordered.find((snapshot) => newest.timestamp - snapshot.timestamp <= maxAgeMs
    && ["absent", "present"].includes(snapshot.shortLimit));
  const windowsByMinutes = new Map();
  for (const snapshot of ordered) {
    if (newest.timestamp - snapshot.timestamp > maxAgeMs) continue;
    for (const window of snapshot.windows || []) {
      const minutes = Number(window.windowMinutes);
      if (minutes === 300 && shortEvidence?.shortLimit === "absent" && snapshot.timestamp <= shortEvidence.timestamp) continue;
      if (!Number.isFinite(minutes) || windowsByMinutes.has(minutes)) continue;
      if (Number.isFinite(Number(window.resetsAt)) && Number(window.resetsAt) < newest.timestamp) continue;
      windowsByMinutes.set(minutes, { ...window });
    }
  }
  const windows = [...windowsByMinutes.values()]
    .sort((a, b) => Number(a.windowMinutes) - Number(b.windowMinutes))
    .map((window, index) => ({ ...window, slot: index === 0 ? "primary" : index === 1 ? "secondary" : `window-${index}` }));
  return {
    ...newest,
    shortLimit: windows.some((window) => window.windowMinutes === 300) ? "present" : shortEvidence?.shortLimit || "unknown",
    primary: windows[0] || null,
    secondary: windows[1] || null,
    windows,
  };
}

function normalizeServiceTier(value) {
  const tier = String(value || "").toLowerCase();
  if (["priority", "fast", "default", "standard"].includes(tier)) return tier;
  return null;
}

function tierEvidence(tier, source) {
  const normalized = normalizeServiceTier(tier);
  if (!normalized) return null;
  return {
    tier: normalized,
    fast: normalized === "priority" || normalized === "fast",
    source,
  };
}

function responseTierFromRecord(record) {
  const payload = record?.payload || {};
  const candidates = [
    payload.response?.service_tier,
    payload.info?.response?.service_tier,
    payload.info?.service_tier,
    payload.response_service_tier,
    payload.actual_service_tier,
    record?.response?.service_tier,
  ];
  const responseLike = /response.*(?:complete|done)|(?:complete|done).*response/i.test(String(payload.type || record?.type || ""));
  if (responseLike) candidates.push(payload.service_tier);
  for (const candidate of candidates) {
    const evidence = tierEvidence(candidate, "response");
    if (evidence) return evidence;
  }
  return null;
}

class CodexUsageScanner {
  constructor(home = codexHomePath()) {
    this.home = home;
    this.fileStates = new Map();
    this.latestRateLimit = null;
    this.planType = null;
    this.planTimestamp = -Infinity;
    this.origins = new Set();
    this.tierTimelines = new Map();
    this.quotaSamples = [];
    this.excludedQuotaSamples = [];
  }

  updatePlanType(planType, timestamp) {
    // Session files and HTTP logs are scanned independently, not in time order.
    if (!planType || !Number.isFinite(timestamp) || timestamp <= this.planTimestamp) return;
    this.planType = String(planType);
    this.planTimestamp = timestamp;
  }

  loadTierTimelines() {
    const dbPath = path.join(this.home, "logs_2.sqlite");
    if (!fs.existsSync(dbPath)) return;
    const timelines = new Map();
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(`
        SELECT ts, thread_id, feedback_log_body
        FROM logs
        WHERE target = 'codex_core::session::handlers'
          AND thread_id IS NOT NULL
          AND feedback_log_body LIKE '%service_tier:%'
        ORDER BY ts ASC, id ASC
      `).all();
      for (const row of rows) {
        const body = String(row.feedback_log_body || "");
        const explicit = body.match(/service_tier:\s*Some\(Some\("(priority|fast|default)"\)\)/i);
        const cleared = /service_tier:\s*Some\(None\)/i.test(body);
        if (!explicit && !cleared) continue;
        const tierName = explicit?.[1]?.toLowerCase() || "default";
        const item = { timestamp: Number(row.ts) * 1000, ...tierEvidence(tierName, "local-log") };
        if (!timelines.has(row.thread_id)) timelines.set(row.thread_id, []);
        timelines.get(row.thread_id).push(item);
      }
      this.tierTimelines = timelines;
    } catch {
      // Logs are optional and can be briefly locked while Codex is writing them.
    } finally {
      try { db?.close(); } catch {}
    }
  }

  loadRateLimitFromLogs() {
    const dbPath = path.join(this.home, "logs_2.sqlite");
    if (!fs.existsSync(dbPath)) return;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(`
        SELECT ts, feedback_log_body
        FROM logs
        WHERE target = 'codex_http_client::client'
          AND (
            feedback_log_body LIKE '%x-codex-primary-window-minutes%'
            OR feedback_log_body LIKE '%x-codex-secondary-window-minutes%'
          )
        ORDER BY ts DESC, id DESC
        LIMIT 512
      `).all();
      const snapshots = rows
        .map((row) => rateLimitFromResponseHeaders(row.feedback_log_body, Number(row.ts)))
        .filter(Boolean);
      for (const snapshot of snapshots) this.collectQuotaSamples(snapshot);
      const rateLimit = mergeRateLimitSnapshots([...snapshots, this.latestRateLimit]);
      if (rateLimit && (!this.latestRateLimit || rateLimit.timestamp >= this.latestRateLimit.timestamp)) this.latestRateLimit = rateLimit;
      for (const snapshot of snapshots) this.updatePlanType(snapshot.planType, snapshot.timestamp);
    } catch {
      // Response headers are optional and the database can be briefly locked while Codex writes to it.
    } finally {
      try { db?.close(); } catch {}
    }
  }

  tierAt(sessionId, timestamp) {
    const timeline = this.tierTimelines.get(sessionId);
    if (!timeline?.length) return null;
    let match = null;
    for (const item of timeline) {
      if (item.timestamp > timestamp) break;
      match = item;
    }
    return match;
  }

  files() {
    return [
      ...walkJsonl(path.join(this.home, "sessions")),
      ...walkJsonl(path.join(this.home, "archived_sessions")),
    ];
  }

  scan() {
    this.quotaSamples = [];
    this.excludedQuotaSamples = [];
    if (!fs.existsSync(this.home)) {
      return { available: false, home: this.home, events: [], rateLimit: null, planType: null, files: 0 };
    }
    const files = this.files();
    this.loadTierTimelines();
    const present = new Set(files);
    const events = [];
    for (const file of files) {
      try {
        this.scanFile(file, events);
      } catch {
        // A session can be moved to the archive while it is being scanned; the next refresh retries it.
      }
    }
    this.loadRateLimitFromLogs();
    for (const file of this.fileStates.keys()) {
      if (!present.has(file)) this.fileStates.delete(file);
    }
    return {
      available: true,
      home: this.home,
      events: collapseCumulativeEvents(events),
      rateLimit: this.latestRateLimit,
      quotaSamples: this.quotaSamples,
      excludedQuotaSamples: this.excludedQuotaSamples,
      planType: this.planType,
      origins: [...this.origins],
      files: files.length,
    };
  }

  collectQuotaSamples(snapshot) {
    for (const window of snapshot.windows || []) {
      if (!window.resetsAt || window.usedPercent == null) continue;
      this.quotaSamples.push({ source: "codex", pool: `${window.slot || "window"}-${window.windowMinutes}`,
        timestamp: snapshot.timestamp, planType: snapshot.planType || null, ...window });
    }
  }

  scanFile(file, events) {
    const stat = fs.statSync(file);
    let state = this.fileStates.get(file);
    if (!state || stat.size < state.offset) {
      state = {
        offset: 0,
        remainder: "",
        sessionId: null,
        model: "unknown",
        effort: null,
        requestTier: null,
        responseTier: null,
      };
    }
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
    for (const line of lines) this.parseLine(line, state, file, events);
    this.fileStates.set(file, state);
  }

  parseLine(line, state, file, events) {
    if (!line) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const payload = record.payload || {};
    if (record.type === "session_meta") {
      state.sessionId = payload.id || payload.session_id || state.sessionId;
      if (payload.originator) this.origins.add(String(payload.originator));
      return;
    }
    if (record.type === "turn_context") {
      if (payload.model) state.model = String(payload.model);
      state.effort = payload.effort == null ? state.effort : String(payload.effort);
      const turnTier = tierEvidence(payload.service_tier, "local-log");
      if (turnTier) state.requestTier = turnTier;
      return;
    }
    if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
      const settingsTier = tierEvidence(payload.thread_settings?.service_tier, "local-log");
      if (settingsTier) state.requestTier = settingsTier;
      return;
    }
    const responseTier = responseTierFromRecord(record);
    if (responseTier && !(record.type === "event_msg" && payload.type === "token_count")) {
      state.responseTier = { ...responseTier, timestamp: Date.parse(record.timestamp) };
      return;
    }
    if (record.type !== "event_msg" || payload.type !== "token_count") return;

    const timestamp = Date.parse(record.timestamp);
    const rateLimits = payload.rate_limits;
    if (Number.isFinite(timestamp) && rateLimits && !isMainCodexRateLimit(rateLimits, state.model)) {
      for (const raw of [rateLimits.primary, rateLimits.secondary]) {
        const window = rateWindow(raw);
        if (window?.resetsAt) this.excludedQuotaSamples.push({ timestamp, ...window });
      }
    }
    if (Number.isFinite(timestamp) && (rateLimits?.primary || rateLimits?.secondary) && isMainCodexRateLimit(rateLimits, state.model)) {
      this.collectQuotaSamples({ timestamp, planType: rateLimits.plan_type,
        windows: [rateWindow(rateLimits.primary), rateWindow(rateLimits.secondary)]
          .map((window, index) => window && { ...window, slot: index === 0 ? "primary" : "secondary" }).filter(Boolean) });
      if (!this.latestRateLimit || timestamp >= this.latestRateLimit.timestamp) {
        const primary = rateWindow(rateLimits.primary);
        const secondary = rateWindow(rateLimits.secondary);
        this.latestRateLimit = {
          timestamp,
          limitId: rateLimits.limit_id || null,
          limitName: rateLimits.limit_name || null,
          primary,
          secondary,
          // Explicit null slots in a full rate_limits object differ from a
          // partial header response which merely omitted a window.
          shortLimit: [primary, secondary].some((window) => window?.windowMinutes === 300) ? "present"
            : Object.hasOwn(rateLimits, "primary") && Object.hasOwn(rateLimits, "secondary")
              && [primary, secondary].some((window) => window?.windowMinutes === 10080) ? "absent" : "unknown",
          windows: [
            primary ? { slot: "primary", ...primary } : null,
            secondary ? { slot: "secondary", ...secondary } : null,
          ].filter(Boolean),
          credits: rateLimits.credits || null,
          planType: rateLimits.plan_type || null,
        };
      }
      this.updatePlanType(rateLimits.plan_type, timestamp);
    }

    const usage = payload.info?.last_token_usage;
    if (!usage || !Number.isFinite(timestamp)) return;
    const cached = Math.max(0, number(usage.cached_input_tokens));
    const cacheWrite = Math.max(
      0,
      number(usage.cache_write_input_tokens),
      number(usage.cache_write_tokens),
      number(usage.input_cache_write_tokens),
      number(usage.input_tokens_details?.cache_write_tokens),
      number(usage.prompt_tokens_details?.cache_write_tokens),
    );
    const rawInput = Math.max(0, number(usage.input_tokens));
    const input = Math.max(0, rawInput - cached - cacheWrite);
    const output = Math.max(0, number(usage.output_tokens));
    const total = Math.max(0, number(usage.total_tokens));
    if (!rawInput && !output && !total) return;
    const sessionId = state.sessionId || path.basename(file, ".jsonl");
    const legacyEventKey = `${sessionId}:${record.timestamp}:${total}:${state.model}:${state.effort || "default"}`;
    const eventKey = cumulativeEventKey(sessionId, payload.info?.total_token_usage) || legacyEventKey;
    const embeddedResponseTier = responseTierFromRecord(record);
    const recentResponseTier = state.responseTier && timestamp - state.responseTier.timestamp >= 0
      && timestamp - state.responseTier.timestamp <= 10 * 60_000 ? state.responseTier : null;
    const serviceTier = embeddedResponseTier || recentResponseTier || state.requestTier || this.tierAt(sessionId, timestamp);
    if (recentResponseTier) state.responseTier = null;
    events.push({
      source: "codex",
      eventKey,
      legacyEventKey: eventKey === legacyEventKey ? null : legacyEventKey,
      timestamp,
      model: state.model || "unknown",
      effort: state.effort,
      fast: Boolean(serviceTier?.fast),
      fastKnown: Boolean(serviceTier),
      serviceTier: serviceTier?.tier || null,
      tierSource: serviceTier?.source || null,
      input,
      output,
      cacheRead: cached,
      cacheWrite,
      reasoning: Math.max(0, number(usage.reasoning_output_tokens)),
      costCents: null,
      count: 1,
    });
  }
}

let singleton;

function scanCodexUsage() {
  if (!singleton) singleton = new CodexUsageScanner();
  return singleton.scan();
}

module.exports = {
  CODEX_EVENT_KEY_PREFIX,
  codexHomePath,
  codexPlanName,
  CodexUsageScanner,
  collapseCumulativeEvents,
  cumulativeEventKey,
  normalizeServiceTier,
  mergeRateLimitSnapshots,
  responseTierFromRecord,
  rateLimitFromResponseHeaders,
  scanCodexUsage,
};
