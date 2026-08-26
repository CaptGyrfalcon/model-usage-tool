@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo 正在安装依赖…
  call npm install
)
if not exist node_modules\electron\dist\electron.exe (
  echo 正在准备 Electron 运行时…
  call node scripts\ensure-electron.cjs
)
start "" /b "%CD%\node_modules\electron\dist\electron.exe" .
