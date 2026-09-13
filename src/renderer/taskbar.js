const panel = document.getElementById('panel');
const rows = document.getElementById('rows');
window.taskbar.onMeters(data => {
  panel.classList.toggle('stale', data.stale);
  rows.replaceChildren(...data.rows.map(row => {
    const line = document.createElement('div'); line.className = 'row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = row.label;
    const meters = document.createElement('div'); meters.className = 'meters';
    for (const item of row.meters) {
      const meter = document.createElement('div'); meter.className = 'meter';
      const known = item.value !== null;
      const value = known ? `${item.value.toFixed(row.label === 'Codex' ? 0 : 1)}%` : '—';
      const label = `${row.label} ${item.label} 剩余 ${known ? value : '未知，等待同步'}`;
      meter.title = label + (data.stale ? ' · 同步失败，显示缓存' : '') + (row.label === 'Codex' && data.sampledAt ? ` · 采样 ${new Date(data.sampledAt).toLocaleString()}` : '');
      meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', label);
      meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
      if (known) {
        meter.setAttribute('aria-valuenow', item.value);
        const hue = item.value <= 50 ? item.value * 2.4 : 120 + (item.value - 50) * 1.8;
        meter.style.setProperty('--value', `${item.value}%`);
        meter.style.setProperty('--dark', `hsl(${hue} 65% 32%)`);
        meter.style.setProperty('--color', `hsl(${hue} 88% 63%)`);
        const fill = document.createElement('span'); fill.className = 'fill'; meter.append(fill);
      } else meter.classList.add('unknown');
      const text = document.createElement('span'); text.className = 'value';
      text.textContent = `${row.label === 'Codex' ? item.label + ' ' : ''}${value}`;
      meter.append(text); meters.append(meter);
    }
    line.append(name, meters); return line;
  }));
});
panel.addEventListener('click', () => window.taskbar.open());
