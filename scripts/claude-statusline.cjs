// Claude Code statusLine command. No network calls or credential access.
const { captureStatusline } = require("../src/claude-statusline.cjs");
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(text);
    let sample;
    try { sample = captureStatusline(input); } catch { /* A write failure must not break the status bar. */ }
    const parts = [input.model?.display_name || "Claude"];
    if (sample?.fh != null) parts.push(`5h: ${sample.fh}% used`);
    if (sample?.sd != null) parts.push(`7d: ${sample.sd}% used`);
    process.stdout.write(parts.join(" | ") + "\n");
  } catch { process.stdout.write("Claude\n"); }
});
