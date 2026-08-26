const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const dist = path.join(electronDir, "dist");
const exe = path.join(dist, "electron.exe");
const pathTxt = path.join(electronDir, "path.txt");

function ok() {
  fs.writeFileSync(pathTxt, "electron.exe");
  console.log("Electron binary ready.");
}

if (fs.existsSync(exe)) {
  ok();
  process.exit(0);
}

const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron", "Cache");
let zip = null;
if (fs.existsSync(cacheRoot)) {
  for (const dir of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, dir, "electron-v37.10.3-win32-x64.zip");
    if (fs.existsSync(candidate)) zip = candidate;
  }
}

if (zip) {
  fs.mkdirSync(dist, { recursive: true });
  const result = spawnSync("tar", ["-xf", zip, "-C", dist], { stdio: "inherit" });
  if (result.status === 0 && fs.existsSync(exe)) {
    ok();
    process.exit(0);
  }
}

const installer = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
  stdio: "inherit",
  env: process.env,
});
if (fs.existsSync(exe)) {
  ok();
  process.exit(0);
}

console.error("无法准备 Electron 运行时。请检查网络后重新执行 npm install。");
process.exit(installer.status || 1);
