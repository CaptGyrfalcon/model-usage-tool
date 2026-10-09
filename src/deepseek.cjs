const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const YAML = require("yaml");
const { decompress } = require("fzstd");
const { zstdDecompressSync } = require("node:zlib");

// Sources: deepseek-ai/deepseek-harness token-meter/usage-projection.ts,
// session-persistence-jsonl/{format,zstd}.ts and credentials-local/index.ts.
function dshHome() {
  return path.resolve(process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh"));
}
function sessionRoots() {
  return process.env.DSH_SESSIONS_DIR
    ? [path.resolve(process.env.DSH_SESSIONS_DIR)] : [path.join(dshHome(), "sessions")];
}
function generationFiles(root, result = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return result; throw error; }
  const logs = entries.filter((entry) => entry.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name));
  if (logs.length) {
    logs.sort((a, b) => Number(b.name.match(/\.v(\d+)/)?.[1] || 0) - Number(a.name.match(/\.v(\d+)/)?.[1] || 0));
    result.push(path.join(root, logs[0].name));
  }
  for (const entry of entries) if (entry.isDirectory()) generationFiles(path.join(root, entry.name), result);
  return result;
}

// Decode only complete concatenated frames. A writer's unfinished final frame
// is retried on the next refresh; it never causes earlier history to be erased.
function completeZstdFrames(buffer) {
  let offset = 0;
  const frames = [];
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5) break;
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error("Harness Zstandard 日志帧损坏");
    const descriptor = buffer[offset + 4];
    if (descriptor & 0x18) throw new Error("Harness Zstandard 日志头损坏");
    const flag = descriptor >>> 6;
    const single = Boolean(descriptor & 0x20);
    const dictionary = descriptor & 3;
    offset += 5 + (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag ? 1 << flag : single ? 1 : 0);
    if (offset > buffer.length) break;
    let complete = false;
    while (offset + 3 <= buffer.length) {
      const block = buffer.readUIntLE(offset, 3);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error("Harness Zstandard 日志块损坏");
      offset += 3 + (type === 1 ? 1 : block >>> 3);
      if (offset > buffer.length) break;
      if (block & 1) { offset += descriptor & 4 ? 4 : 0; complete = offset <= buffer.length; break; }
    }
    if (!complete) break;
    frames.push({ start, end: offset });
  }
  return frames;
}
function completeZstdPrefix(buffer) {
  return buffer.subarray(0, completeZstdFrames(buffer).at(-1)?.end || 0);
}
function decodeZstd(buffer, decoder = zstdDecompressSync || decompress) {
  return Buffer.concat(completeZstdFrames(buffer).map(({ start, end }) => Buffer.from(decoder(buffer.subarray(start, end))))).toString("utf8");
}
function usageOf(record) {
  if (record.type === "assistant/message" && record.data?.usage) return record.data.usage;
  const stream = record.data?.stream || [];
  for (let i = stream.length - 1; i >= 0; i--) {
    if (stream[i].chunk?.type === "usage") return stream[i].chunk.usage;
  }
  return null;
}
function parseSession(text) {
  const lines = text.split("\n");
  // Plain JSONL may end in a partially written record.
  if (lines.at(-1)?.trim()) lines.pop();
  const rows = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
  const header = rows.shift();
  if (header?.type !== "session" || !header.id) throw new Error("Harness 会话缺少有效头记录");
  if (!Number.isInteger(header.version) || header.version < 0 || header.version > 4) throw new Error("Harness 会话格式版本暂不支持");
  let cut = Number(header.inheritedEventCount) || 0;
  if (header.isSeeded) {
    const seed = rows.filter((row) => row.type === "session/end-seed" && row.data?.inherited).at(-1);
    if (!seed && !cut) throw new Error("Harness 分叉会话缺少继承边界");
    if (seed) cut = Number(seed.seq) + 1;
  }
  let config = {}, last = null;
  const slots = new Map();
  const counts = new Map();
  for (const row of rows) {
    if (row.type === "request/header") config = row.data?.header?.config || {};
    if (row.seq < cut) continue;
    const data = row.data || {};
    const key = `${data.turn}:${data.step}`;
    if (row.type === "llm/retry-started") {
      if (last?.stepKey === key) last = null;
      continue;
    }
    if (!["assistant/message", "assistant/attempt"].includes(row.type)) continue;
    const usage = usageOf(row);
    if (!usage) continue;
    const raw = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
    if (!raw.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("Harness Token 计数无效");
    const timestamp = Number(row.time);
    if (!Number.isFinite(timestamp)) throw new Error("Harness Token 记录缺少时间");
    const route = data.message?.source || data.message || config;
    const model = route.model || config.model || "unknown";
    let eventKey;
    if (last?.stepKey === key) eventKey = last.eventKey;
    else {
      const attempt = counts.get(key) || 0;
      counts.set(key, attempt + 1);
      eventKey = `deepseek:${header.id}:${key}:${attempt}`;
    }
    slots.set(eventKey, {
      source: "deepseek", eventKey, timestamp, model, pool: "deepseek",
      effort: config.reasoningEffort || null, fast: false, fastKnown: false,
      input: raw[0], output: raw[1], cacheRead: raw[2], cacheWrite: raw[3],
      reasoning: Number.isSafeInteger(usage.reasoningTokens) ? Math.max(0, usage.reasoningTokens) : 0,
      count: 1, costCents: null, pricingStatus: "unavailable",
    });
    last = { stepKey: key, eventKey };
  }
  return [...slots.values()];
}
class DeepSeekScanner {
  constructor(roots = sessionRoots()) { this.roots = roots; this.states = new Map(); }
  scan() {
    const events = [], errors = [], files = [];
    for (const root of this.roots) {
      try { generationFiles(root, files); } catch { errors.push("Harness 会话目录无法读取"); }
    }
    for (const file of new Set(files)) {
      try {
        const stat = fs.statSync(file);
        const signature = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
        if (this.states.get(file) === signature) continue;
        const bytes = fs.readFileSync(file);
        const text = file.endsWith(".zstd") ? decodeZstd(bytes) : bytes.toString("utf8");
        events.push(...parseSession(text));
        this.states.set(file, signature);
      } catch { errors.push("Harness 会话读取失败（格式、压缩或文件权限），已保留历史"); }
    }
    return { events, roots: this.roots, files: files.length, scanErrors: errors };
  }
}
let scanner;
function scanDeepSeekUsage() {
  const roots = sessionRoots();
  if (!scanner || JSON.stringify(scanner.roots) !== JSON.stringify(roots)) scanner = new DeepSeekScanner(roots);
  return scanner.scan();
}
function readOptional(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
function dotenvKey(text) {
  const raw = text.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*?)\s*$/m)?.[1];
  if (!raw) return null;
  if (/^["']/.test(raw)) return raw.slice(1, raw.lastIndexOf(raw[0]));
  return raw.replace(/\s+#.*$/, "").trim();
}
function resolveCredential({ home = dshHome(), env = process.env, cwd = process.cwd() } = {}) {
  if (typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.trim()) return { kind: "api-key", secret: env.DEEPSEEK_API_KEY.trim() };
  const document = YAML.parse(readOptional(path.join(home, ".credentials.yaml"))) || {};
  if (document.version != null && document.version !== 1) throw new Error("Harness 凭据格式版本暂不支持");
  const grant = document.records?.["deepseek-account-platform/default"];
  if (grant?.kind === "grant") {
    const payload = grant.payload;
    if (payload?.version !== 1 || payload.issuer !== "https://platform.deepseek.com" || typeof payload.token !== "string" || !payload.token) {
      throw new Error("Harness 账号凭据无效或来自非官方平台");
    }
    return { kind: "account", secret: payload.token };
  }
  const key = env.DEEPSEEK_API_KEY || (document.version === 1 ? document.refs?.DEEPSEEK_API_KEY : document.DEEPSEEK_API_KEY)
    || dotenvKey(readOptional(path.join(cwd, ".env"))) || dotenvKey(readOptional(path.join(home, ".env")));
  return typeof key === "string" && key.trim() ? { kind: "api-key", secret: key.trim() } : null;
}
function amount(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) throw new Error("DeepSeek 余额响应格式无效");
  return Number(value);
}
function normalizeBalances(body, kind) {
  if (kind === "api-key") {
    if (!Array.isArray(body?.balance_infos) || !body.balance_infos.length) throw new Error("DeepSeek 余额响应格式无效");
    return body.balance_infos.map((wallet) => ({ currency: wallet.currency,
      total: amount(wallet.total_balance), toppedUp: amount(wallet.topped_up_balance), granted: amount(wallet.granted_balance) }));
  }
  if (body?.code !== 0 || body.data?.biz_code !== 0) throw new Error("Harness 账号余额查询失败，请检查登录状态");
  const data = body.data.biz_data;
  if (!Array.isArray(data?.normal_wallets) || !Array.isArray(data?.bonus_wallets)) throw new Error("DeepSeek 钱包响应格式无效");
  const wallets = new Map();
  for (const [field, entries] of [["toppedUp", data.normal_wallets], ["granted", data.bonus_wallets]]) {
    for (const entry of entries) {
      if (!wallets.has(entry.currency)) wallets.set(entry.currency, { currency: entry.currency, toppedUp: 0, granted: 0 });
      wallets.get(entry.currency)[field] += amount(entry.balance);
    }
  }
  if (!wallets.size) throw new Error("DeepSeek 钱包响应为空");
  return [...wallets.values()].map((wallet) => ({ ...wallet, total: wallet.toppedUp + wallet.granted }));
}
async function fetchBalance(history, { credential = resolveCredential(), fetchFn = fetch, now = Date.now() } = {}) {
  if (!credential) {
    history.saveCache("deepseek-active-account", { accountKey: null });
    return { ok: false, cached: false, balances: [], error: "未找到 Harness 登录凭据或 DEEPSEEK_API_KEY" };
  }
  const accountKey = createHash("sha256").update(`${credential.kind}:${credential.secret}`).digest("hex");
  history.saveCache("deepseek-active-account", { accountKey });
  const cacheKey = `deepseek-balance:${accountKey}`;
  const cached = history.loadCache(cacheKey)?.value;
  try {
    const isAccount = credential.kind === "account";
    const response = await fetchFn(isAccount ? "https://platform.deepseek.com/api/v0/users/get_user_summary" : "https://api.deepseek.com/user/balance", {
      method: "GET", headers: isAccount ? { "x-dsh-auth-token": credential.secret } : { Authorization: `Bearer ${credential.secret}` },
      redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败（HTTP ${response.status}）`);
    const balances = normalizeBalances(await response.json(), credential.kind);
    if (balances.some((wallet) => !["CNY", "USD"].includes(wallet.currency))) throw new Error("DeepSeek 返回了不支持的币种");
    const result = { ok: true, cached: false, accountKey, kind: credential.kind, balances, sampledAt: now, error: null };
    history.saveCache(cacheKey, result);
    history.saveCache("deepseek-active-account", { accountKey });
    for (const wallet of balances) history.saveBalanceSample({ ...wallet, source: "deepseek", accountKey, timestamp: now });
    return result;
  } catch (error) {
    // Never expose transport errors, response bodies or credentials to the UI.
    const message = /^DeepSeek|^Harness/.test(error.message) ? error.message : "DeepSeek 余额查询暂不可用，请稍后刷新";
    return { ...(cached || { accountKey, kind: credential.kind, balances: [] }), ok: false, cached: Boolean(cached), error: message };
  }
}
module.exports = { dshHome, sessionRoots, generationFiles, completeZstdPrefix, decodeZstd, parseSession, DeepSeekScanner, scanDeepSeekUsage, resolveCredential, normalizeBalances, fetchBalance };
