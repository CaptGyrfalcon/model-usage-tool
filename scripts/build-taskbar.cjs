const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function buildTaskbar(outputDirectory = path.join(__dirname, '../out/native')) {
  const sources = ['taskbar-native.cs', 'taskbar-events.cs', 'taskbar-native.manifest'].map(name => path.join(__dirname, '../src', name));
  const hash = createHash('sha256');
  for (const file of sources) hash.update(fs.readFileSync(file));
  const output = path.join(outputDirectory, `quota-taskbar-${hash.digest('hex').slice(0, 16)}.exe`);
  if (fs.existsSync(output)) return output;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const references = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'WPF/WindowsBase.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll'];
  const temporary = `${output}.${process.pid}.exe`;
  try {
    await promisify(execFile)(path.join(framework, 'csc.exe'), [
      '/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${temporary}`,
      `/win32manifest:${sources[2]}`, ...references.map(name => `/reference:${path.join(framework, name)}`), ...sources.slice(0, 2),
    ], { windowsHide: true, timeout: 60000 });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Native taskbar build failed: ${error.stdout || error.message}`);
  }
  return output;
}
module.exports = { buildTaskbar };
if (require.main === module) buildTaskbar().then(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
