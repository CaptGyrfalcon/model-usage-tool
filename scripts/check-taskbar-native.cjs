const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const output = path.join(root, 'out/native');
fs.mkdirSync(output, { recursive: true });
const exe = path.join(output, 'taskbar-checks.exe');
const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'WPF/WindowsBase.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll'];
execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/main:TaskbarNativeChecks', `/out:${exe}`,
  `/win32manifest:${path.join(root, 'src/taskbar-native.manifest')}`, ...refs.map(name => `/reference:${path.join(framework, name)}`),
  ...['src/taskbar-native.cs', 'src/taskbar-events.cs', 'test/taskbar-native-checks.cs'].map(name => path.join(root, name)),
], { windowsHide: true, stdio: 'inherit' });
execFileSync(exe, process.argv.includes('--desktop') ? ['--desktop', path.join(output, 'taskbar-desktop.png')] : [path.join(output, 'taskbar-themes.png')], { windowsHide: true, stdio: 'inherit', timeout: 15000 });
