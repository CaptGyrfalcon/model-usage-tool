@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist node_modules\electron\dist\electron.exe (
  echo Preparing Electron runtime...
  call node scripts\ensure-electron.cjs
)
start "" /b "%CD%\node_modules\electron\dist\electron.exe" .
