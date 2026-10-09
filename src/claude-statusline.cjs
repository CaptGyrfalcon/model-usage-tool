const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

function statuslinePath() {
  return path.join(os.homedir(), "AppData", "Roaming", "cursor-usage-widget", "claude-statusline.jsonl");
}

// Store only quota observations, never the full stdin (which includes workspace data).
function parseStatusline(input, now = Date.now()) {
  const sample = { timestamp: now, fh: null, sd: null };
  for (const [key, name] of [["fh", "five_hour"], ["sd", "seven_day"]]) {
    const window = input?.rate_limits?.[name];
    const used = window?.used_percentage;
    const reset = window?.resets_at;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (typeof reset !== "number" || !Number.isFinite(reset) || reset * 1000 <= now) continue;
    sample[key] = used;
    sample[`${key}ResetsAt`] = reset * 1000;
  }
  return sample.fh == null && sample.sd == null ? null : sample;
}

function captureStatusline(input, { file = statuslinePath(), now = Date.now() } = {}) {
  const sample = parseStatusline(input, now);
  if (!sample) return null;
  const session = createHash("sha256").update(String(input.session_id || "default")).digest("hex");
  // Status bars also run on UI changes/timers with cached values. Do not turn
  // an unchanged response from an idle session into a new quota observation.
  try {
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n").reverse()) {
      let previous;
      try { previous = JSON.parse(line); } catch { continue; }
      if (previous.session !== session) continue;
      if (["fh", "sd", "fhResetsAt", "sdResetsAt"].every((key) => previous[key] === sample[key])) return previous;
      break;
    }
  } catch { /* First observation. */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One append per observation allows independent sessions to share the journal.
  fs.appendFileSync(file, JSON.stringify({ ...sample, session }) + "\n");
  return sample;
}

function readStatusline(file = statuslinePath(), now = Date.now()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { return { file, samples: [], error: error.code === "ENOENT" ? null : error.message }; }
  const samples = [];
  for (const line of text.split("\n")) {
    try {
      const raw = JSON.parse(line);
      if (!Number.isFinite(raw.timestamp) || raw.timestamp > now || raw.timestamp < now - 35 * 86_400_000) continue;
      const sample = parseStatusline({ rate_limits: {
        five_hour: { used_percentage: raw.fh, resets_at: raw.fhResetsAt / 1000 },
        seven_day: { used_percentage: raw.sd, resets_at: raw.sdResetsAt / 1000 },
      } }, raw.timestamp);
      if (sample) samples.push(sample);
    } catch { /* Ignore incomplete or damaged lines without losing other observations. */ }
  }
  samples.sort((a, b) => a.timestamp - b.timestamp);
  return { file, samples, error: null };
}

module.exports = { statuslinePath, parseStatusline, captureStatusline, readStatusline };
