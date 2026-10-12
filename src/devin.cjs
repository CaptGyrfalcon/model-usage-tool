const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

// Verified against the installed Devin CLI 3000.11.3 (Windows).
const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
function devinHome(env = process.env) {
  return path.resolve(env.DEVIN_HOME || (env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "devin")
    : process.platform === "win32" ? path.join(env.APPDATA || path.join(os.homedir(), "AppData/Roaming"), "devin")
      : path.join(os.homedir(), ".local/share/devin")));
}
function credentialsFile(env = process.env) {
  return env.DEVIN_USAGE_CREDENTIALS_FILE || path.join(devinHome(env), "credentials.toml");
}
function sessionsFile(env = process.env) {
  return env.DEVIN_SESSIONS_DB || path.join(devinHome(env), "cli/sessions.db");
}
function readCredential(file = credentialsFile()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Devin 登录配置无法读取"); }
  const field = (name) => {
    const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, "m"));
    if (!match) return null;
    return match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1);
  };
  let secret, server;
  try { secret = field("windsurf_api_key"); server = new URL(field("api_server_url")); }
  catch { throw new Error("Devin 登录配置格式无效"); }
  if (!secret || server.protocol !== "https:" || server.username || server.password || server.port
    || !/(^|\.)(codeium\.com|devin\.ai|windsurf\.com)$/.test(server.hostname)) {
    throw new Error("Devin 登录配置缺少凭据或不是受支持的官方 HTTPS 服务");
  }
  return { secret, server: server.origin, accountKey: createHash("sha256").update(`${server.origin}\0${secret}`).digest("hex").slice(0, 24) };
}
function number(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function time(value) {
  if (typeof value === "object" && value) value = value.seconds;
  const n = number(value);
  return n != null ? (n < 1e12 ? n * 1000 : n) : typeof value === "string" ? (Date.parse(value) || null) : null;
}
function normalizeStatus(payload, now = Date.now()) {
  const status = payload?.userStatus;
  const plan = status?.planStatus;
  if (!plan || typeof plan !== "object") throw new Error("Devin 未返回可识别的订阅数据");
  const info = plan.planInfo || status.planInfo || payload.planInfo || {};
  const windows = [];
  for (const [prefix, minutes, name] of [["daily", 1440, "每日"], ["weekly", 10080, "每周"]]) {
    if (info[`hide${prefix === "daily" ? "Daily" : "Weekly"}Quota`] === true) continue;
    const remaining = number(plan[`${prefix}QuotaRemainingPercent`]);
    if (remaining == null) continue;
    if (remaining < 0 || remaining > 100) throw new Error("Devin 额度百分比无效");
    const resetsAt = time(plan[`${prefix}QuotaResetAtUnix`]);
    windows.push({ name, windowMinutes: minutes, pool: `devin-${minutes}`, usedPercent: 100 - remaining,
      percentRemaining: remaining, resetsAt, startsAt: resetsAt == null ? null : resetsAt - minutes * 60000,
      startEstimated: true, sampledAt: now, expired: resetsAt != null && resetsAt <= now });
  }
  const credits = {};
  for (const key of ["availablePromptCredits", "usedPromptCredits", "availableFlowCredits", "usedFlowCredits",
    "availableFlexCredits", "usedFlexCredits", "overageBalanceMicros", "acuConsumed", "acuLimit"]) {
    const n = number(plan[key]);
    if (n != null) credits[key] = n; // -1 is a vendor sentinel, never a negative balance.
  }
  if (!windows.length && !Object.keys(credits).length) throw new Error("Devin 返回的订阅没有用量字段");
  return { planName: typeof info.planName === "string" ? info.planName : "Devin",
    billingStrategy: info.billingStrategy ?? null, planStart: time(plan.planStart), planEnd: time(plan.planEnd),
    quota: { windows }, credits, sampledAt: now };
}
async function fetchSubscription(history, { now = Date.now(), fetchImpl = fetch, file = credentialsFile(), force = false } = {}) {
  let credential;
  try { credential = readCredential(file); }
  catch (error) { history.saveCache("devin-active-account", { accountKey: null }); return { ok: false, cached: false, error: error.message }; }
  const accountKey = credential?.accountKey || null;
  history.saveCache("devin-active-account", { accountKey });
  if (!credential) return { ok: false, cached: false, error: "未找到 Devin CLI 登录配置，请先登录 Devin" };
  const key = `devin-subscription:${accountKey}`;
  const previous = history.loadCache(key)?.value;
  const attemptKey = `${key}:attempt`;
  const attempt = history.loadCache(attemptKey)?.value;
  const decorate = (value, cached, error = null) => ({ ...value, accountKey, ok: !error, cached, error,
    quota: { windows: value.quota.windows.map(w => ({ ...w, pool: `devin-${w.windowMinutes}:${accountKey}`,
      expired: w.resetsAt != null && w.resetsAt <= now })) } });
  // Normal widget refreshes share a one-minute, account-specific cache.
  if (!force && previous && now >= previous.sampledAt && now - previous.sampledAt < 60000) return decorate(previous, true);
  if (!force && attempt?.error && now >= attempt.at && now - attempt.at < 60000) {
    return previous ? decorate(previous, true, attempt.error) : { ok: false, cached: false, accountKey, error: attempt.error };
  }
  try {
    const response = await fetchImpl(credential.server + STATUS_PATH, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: JSON.stringify({ metadata: { apiKey: credential.secret, ideName: "devin", ideVersion: "3000.11.3", extensionVersion: "3000.11.3", locale: "en" } }),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Devin 登录已失效，请重新登录 CLI" : `Devin 订阅查询失败（HTTP ${response.status}）`);
    const value = normalizeStatus(await response.json(), Date.now());
    // Store only allowlisted subscription fields; no raw response or identity.
    history.saveCache(key, value);
    history.saveCache(attemptKey, { at: now, error: null });
    const result = decorate(value, false);
    for (const w of result.quota.windows) if (!w.expired) history.saveQuotaSample({ source: "devin", ...w, timestamp: w.sampledAt });
    return result;
  } catch (error) {
    const message = /^Devin /.test(error.message) ? error.message : "Devin 订阅暂不可用，已保留最近成功数据";
    history.saveCache(attemptKey, { at: now, error: message });
    return previous ? decorate(previous, true, message) : { ok: false, cached: false, accountKey, error: message };
  }
}
function eventFromMetadata(row) {
  const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  const m = meta?.metrics;
  if (!m) return null;
  if (m.input_tokens == null && m.output_tokens === 0 && m.cache_read_tokens == null && m.cache_creation_tokens == null) return null;
  const raw = [m.input_tokens, m.output_tokens, m.cache_read_tokens ?? 0, m.cache_creation_tokens ?? 0];
  if (!raw.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Devin Token 计数无效");
  const timestamp = time(meta.created_at) ?? time(row.created_at);
  if (timestamp == null) throw new Error("Devin 请求缺少时间");
  const identity = meta.request_id || row.messageId;
  if (!identity) throw new Error("Devin 请求缺少稳定标识");
  // Request IDs survive tool-call splitting and inherited fork nodes.
  const eventKey = `devin:${createHash("sha256").update(String(identity)).digest("hex")}`;
  const model = typeof meta.generation_model === "string" ? meta.generation_model : "unknown";
  return { source: "devin", eventKey, timestamp, model, pool: "devin", count: 1,
    effort: model.match(/-(ultra|max|xhigh|high|medium|low|minimal|none)$/)?.[1] || null,
    fast: false, fastKnown: false, input: raw[0], output: raw[1], cacheRead: raw[2], cacheWrite: raw[3],
    costCents: null, pricingStatus: "unavailable" };
}
function scanDevinUsage(file = sessionsFile()) {
  if (!fs.existsSync(file)) return { events: [], files: 0, scanErrors: [] };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const events = new Map();
    const errors = [];
    // Extract only usage metadata and identifiers in SQL, never message content.
    const rows = db.prepare(`SELECT json_extract(chat_message, '$.metadata') AS metadata,
      json_extract(chat_message, '$.message_id') AS messageId, created_at
      FROM message_nodes WHERE json_valid(chat_message)
      AND json_extract(chat_message, '$.role') = 'assistant'
      AND json_extract(chat_message, '$.metadata.metrics') IS NOT NULL ORDER BY row_id`).iterate();
    for (const row of rows) {
      try {
        const event = eventFromMetadata(row);
        if (event) events.set(event.eventKey, event);
      } catch { errors.push("Devin 部分请求元数据无效，已保留可读记录及历史"); }
    }
    return { events: [...events.values()], files: 1, scanErrors: [...new Set(errors)] };
  } catch { return { events: [], files: 1, scanErrors: ["Devin 会话库无法读取（格式或权限），已保留历史"] }; }
  finally { db?.close(); }
}
class DevinUsageScanner {
  constructor(file = sessionsFile(), read = scanDevinUsage) {
    this.file = file;
    this.read = read;
    this.signature = null;
    this.eventSignatures = new Map();
  }

  scan() {
    let signature;
    try {
      signature = [this.file, `${this.file}-wal`].map(file => {
        try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
        catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
      }).join("|");
    } catch { return this.read(this.file); }
    if (signature === this.signature) return { events: [], files: fs.existsSync(this.file) ? 1 : 0, scanErrors: [] };
    const result = this.read(this.file);
    if (result.scanErrors.length) return result; // Retry transient / partial reads.
    const next = new Map();
    const events = result.events.filter(event => {
      const fingerprint = JSON.stringify(event);
      next.set(event.eventKey, fingerprint);
      return fingerprint !== this.eventSignatures.get(event.eventKey);
    });
    this.signature = signature;
    this.eventSignatures = next;
    return { ...result, events };
  }
}
let usageScanner;
function scanIncrementalDevinUsage() {
  const file = sessionsFile();
  if (!usageScanner || usageScanner.file !== file) usageScanner = new DevinUsageScanner(file);
  return usageScanner.scan();
}

module.exports = { STATUS_PATH, devinHome, credentialsFile, sessionsFile, readCredential, normalizeStatus, DevinUsageScanner, scanIncrementalDevinUsage,
  fetchSubscription, eventFromMetadata, scanDevinUsage };
