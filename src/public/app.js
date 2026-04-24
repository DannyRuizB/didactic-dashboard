const hostsEl    = document.getElementById('hosts');
const errorBox   = document.getElementById('error-box');
const form       = document.getElementById('add-form');
const ipInput    = document.getElementById('ip-input');
const checkType  = document.getElementById('check-type');
const userInput  = document.getElementById('user-input');
const portInput  = document.getElementById('port-input');
const nameInput  = document.getElementById('name-input');
const demoBanner = document.getElementById('demo-banner');

// id -> window ('1h'|'24h'|'7d'|'30d') for hosts whose chart panel is open
const expanded = new Map();
// id -> { pct: Chart, load: Chart } so we can destroy them before re-rendering
const charts = new Map();

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.demo) {
      demoBanner.hidden = false;
      const sshOpt = checkType.querySelector('option[value="ssh"]');
      if (sshOpt) sshOpt.remove();
    }
  } catch { /* fine without config */ }
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { errorBox.hidden = true; }, 4000);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 5)    return 'just now';
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatUptime(s) {
  if (s == null || isNaN(s)) return '--';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pctBar(label, value) {
  if (value == null || isNaN(value)) return '';
  const pct = Math.max(0, Math.min(100, value));
  let cls = 'metric-fill';
  if (pct >= 90)       cls += ' critical';
  else if (pct >= 70)  cls += ' warning';
  return `
    <div class="metric">
      <span class="metric-label">${label}</span>
      <span class="metric-track"><span class="${cls}" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="metric-value">${pct.toFixed(0)}%</span>
    </div>
  `;
}

function renderHost(h) {
  let statusClass = 'unknown';
  let statusText  = 'UNKNOWN';
  if (h.last_ts != null) {
    if (h.last_ok) { statusClass = 'up';   statusText = 'UP'; }
    else           { statusClass = 'down'; statusText = 'DOWN'; }
  }

  let mode;
  if      (h.check_type === 'ssh') mode = `SSH/${h.port || 22}`;
  else if (h.check_type === 'tcp') mode = `TCP/${h.port}`;
  else                             mode = 'ICMP';

  let targetDisplay;
  if      (h.check_type === 'ssh') targetDisplay = `${h.ssh_user}@${h.ip}`;
  else if (h.port)                 targetDisplay = `${h.ip}:${h.port}`;
  else                             targetDisplay = h.ip;

  const latency = h.last_ok && h.last_latency != null
    ? `${h.last_latency.toFixed(0)} ms`
    : '--';

  const title = h.name ? escapeHTML(h.name) : escapeHTML(targetDisplay);
  const sub   = h.name ? `<p class="ip">${escapeHTML(targetDisplay)}</p>` : '';

  let metricsHtml = '';
  if (h.check_type === 'ssh' && h.cpu != null) {
    metricsHtml = `
      <div class="metrics">
        ${pctBar('CPU', h.cpu)}
        ${pctBar('RAM', h.ram)}
        ${pctBar('Disk', h.disk)}
        <div class="metric-foot">
          <span>load ${h.load1 != null ? h.load1.toFixed(2) : '--'}</span>
          <span>up ${formatUptime(h.uptime_s)}</span>
        </div>
      </div>
    `;
  }

  const chartToggle = h.check_type === 'ssh'
    ? `<button class="chart-toggle" data-id="${h.id}" title="Toggle history">chart</button>`
    : '';

  const isOpen = expanded.has(h.id);
  const activeWin = expanded.get(h.id) || '1h';
  const winBtn = (w) =>
    `<button data-id="${h.id}" data-window="${w}" class="win-btn${w === activeWin ? ' active' : ''}">${w}</button>`;

  const chartPanel = h.check_type === 'ssh'
    ? `
      <div class="chart-panel" id="chart-panel-${h.id}"${isOpen ? '' : ' hidden'}>
        <div class="window-picker">
          ${winBtn('1h')}${winBtn('24h')}${winBtn('7d')}${winBtn('30d')}
        </div>
        <canvas id="chart-pct-${h.id}"  class="chart-pct"></canvas>
        <canvas id="chart-load-${h.id}" class="chart-load"></canvas>
      </div>`
    : '';

  return `
    <article class="card ${statusClass}">
      <header>
        <span class="dot"></span>
        <span class="status">${statusText}</span>
        <span class="mode">${mode}</span>
        ${chartToggle}
        <button class="delete" data-id="${h.id}" title="Remove host" aria-label="Remove host">x</button>
      </header>
      <h2>${title}</h2>
      ${sub}
      ${metricsHtml}
      ${chartPanel}
      <footer>
        <span class="latency">${latency}</span>
        <span class="checked">${relativeTime(h.last_ts)}</span>
      </footer>
    </article>
  `;
}

function destroyCharts(id) {
  const c = charts.get(id);
  if (!c) return;
  if (c.pct)  c.pct.destroy();
  if (c.load) c.load.destroy();
  charts.delete(id);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function drawChart(id) {
  const window = expanded.get(id) || '1h';
  let data;
  try {
    const res = await fetch(`/api/hosts/${id}/history?window=${window}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    return;
  }

  destroyCharts(id);
  const pctEl  = document.getElementById(`chart-pct-${id}`);
  const loadEl = document.getElementById(`chart-load-${id}`);
  if (!pctEl || !loadEl) return;

  const fmtShort = (window === '7d' || window === '30d')
    ? (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const labels = data.metrics.map((m) => fmtShort(new Date(m.ts * 1000)));
  const axis = cssVar('--fg-dim') || '#888';
  const grid = cssVar('--border') || '#333';

  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: axis, font: { family: 'monospace' } } },
      tooltip: { mode: 'index', intersect: false },
    },
    scales: {
      x: {
        ticks: { color: axis, maxTicksLimit: 6, autoSkip: true },
        grid:  { color: grid },
      },
      y: {
        ticks: { color: axis },
        grid:  { color: grid },
      },
    },
  };

  const series = (metric) => data.metrics.map((m) => m[metric]);

  const pctChart = new Chart(pctEl, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'CPU %',  data: series('cpu'),  borderColor: '#ff9e3d', backgroundColor: '#ff9e3d33', tension: 0.2, pointRadius: 0, borderWidth: 2 },
        { label: 'RAM %',  data: series('ram'),  borderColor: '#6ecbff', backgroundColor: '#6ecbff33', tension: 0.2, pointRadius: 0, borderWidth: 2 },
        { label: 'Disk %', data: series('disk'), borderColor: '#b58cff', backgroundColor: '#b58cff33', tension: 0.2, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: { ...baseOpts, scales: { ...baseOpts.scales, y: { ...baseOpts.scales.y, min: 0, max: 100 } } },
  });

  const loadChart = new Chart(loadEl, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'load1', data: series('load1'), borderColor: '#7fd18b', backgroundColor: '#7fd18b33', tension: 0.2, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: { ...baseOpts, scales: { ...baseOpts.scales, y: { ...baseOpts.scales.y, beginAtZero: true } } },
  });

  charts.set(id, { pct: pctChart, load: loadChart });
}

async function loadHosts() {
  try {
    const res = await fetch('/api/hosts');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const hosts = await res.json();

    // innerHTML assignment destroys <canvas> nodes — release chart instances first.
    for (const id of charts.keys()) destroyCharts(id);

    if (hosts.length === 0) {
      hostsEl.innerHTML = '<p class="empty">No hosts yet. Add one above.</p>';
      return;
    }
    hostsEl.innerHTML = hosts.map(renderHost).join('');

    // Redraw any panels that were open before the refresh.
    const liveIds = new Set(hosts.map((h) => h.id));
    for (const id of expanded.keys()) {
      if (!liveIds.has(id)) { expanded.delete(id); continue; }
      drawChart(id);
    }
  } catch {
    showError('Could not load hosts');
  }
}

hostsEl.addEventListener('click', async (e) => {
  const del = e.target.closest('.delete');
  if (del) {
    const id = del.dataset.id;
    if (!confirm('Remove this host?')) return;
    try {
      const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      expanded.delete(parseInt(id, 10));
      loadHosts();
    } catch {
      showError('Could not delete host');
    }
    return;
  }

  const toggle = e.target.closest('.chart-toggle');
  if (toggle) {
    const id = parseInt(toggle.dataset.id, 10);
    const panel = document.getElementById(`chart-panel-${id}`);
    if (!panel) return;
    if (expanded.has(id)) {
      expanded.delete(id);
      destroyCharts(id);
      panel.hidden = true;
    } else {
      expanded.set(id, '1h');
      panel.hidden = false;
      drawChart(id);
    }
    return;
  }

  const win = e.target.closest('.win-btn');
  if (win) {
    const id = parseInt(win.dataset.id, 10);
    expanded.set(id, win.dataset.window);
    // refresh active class without a full re-render
    const panel = document.getElementById(`chart-panel-${id}`);
    if (panel) {
      panel.querySelectorAll('.win-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.window === win.dataset.window));
    }
    drawChart(id);
  }
});

function updateFormFields() {
  const t = checkType.value;
  userInput.hidden = (t !== 'ssh');
  portInput.hidden = (t === 'icmp');
  userInput.required = (t === 'ssh');
  portInput.required = (t === 'tcp');
  portInput.placeholder = (t === 'ssh') ? 'port (default 22)' : 'port';
  if (t !== 'ssh')  userInput.value = '';
  if (t === 'icmp') portInput.value = '';
}
checkType.addEventListener('change', updateFormFields);
updateFormFields();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip   = ipInput.value.trim();
  const type = checkType.value;
  const user = userInput.value.trim();
  const port = portInput.value.trim();
  const name = nameInput.value.trim();
  if (!ip) return;
  try {
    const res = await fetch('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip,
        name: name || undefined,
        port: port || undefined,
        check_type: type,
        ssh_user: user || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not add host');
      return;
    }
    ipInput.value = '';
    userInput.value = '';
    portInput.value = '';
    nameInput.value = '';
    checkType.value = 'icmp';
    updateFormFields();
    loadHosts();
  } catch {
    showError('Network error');
  }
});

const themeToggle = document.getElementById('theme-toggle');
function renderThemeButton() {
  const current = document.documentElement.dataset.theme || 'dark';
  themeToggle.textContent = `theme: ${current}`;
}
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('didactic-theme', next);
  renderThemeButton();
});
renderThemeButton();

loadConfig();
loadHosts();
setInterval(loadHosts, 5000);
