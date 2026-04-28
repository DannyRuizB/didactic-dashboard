const hostsEl    = document.getElementById('hosts');
const errorBox   = document.getElementById('error-box');
const form       = document.getElementById('add-form');
const ipInput    = document.getElementById('ip-input');
const checkType  = document.getElementById('check-type');
const userInput     = document.getElementById('user-input');
const portInput     = document.getElementById('port-input');
const servicesInput = document.getElementById('services-input');
const nameInput     = document.getElementById('name-input');
const demoBanner    = document.getElementById('demo-banner');

const advancedToggle = document.getElementById('advanced-toggle');
const advancedBlock  = document.getElementById('advanced-block');
const thresholdInputs = {
  cpu_warn:  document.getElementById('cpu-warn-input'),
  cpu_crit:  document.getElementById('cpu-crit-input'),
  ram_warn:  document.getElementById('ram-warn-input'),
  ram_crit:  document.getElementById('ram-crit-input'),
  disk_warn: document.getElementById('disk-warn-input'),
  disk_crit: document.getElementById('disk-crit-input'),
};

const editDialog   = document.getElementById('edit-dialog');
const editForm     = document.getElementById('edit-form');
const editTarget   = document.getElementById('edit-target');
const editName     = document.getElementById('edit-name');
const editPort     = document.getElementById('edit-port');
const editUser     = document.getElementById('edit-user');
const editServices = document.getElementById('edit-services');
const editError    = document.getElementById('edit-error');
const editPortRow       = document.getElementById('edit-port-row');
const editUserRow       = document.getElementById('edit-user-row');
const editServicesRow   = document.getElementById('edit-services-row');
const editThresholdsRow = document.getElementById('edit-thresholds-row');
const editCancel   = document.getElementById('edit-cancel');
const editThresholdInputs = {
  cpu_warn:  document.getElementById('edit-cpu-warn'),
  cpu_crit:  document.getElementById('edit-cpu-crit'),
  ram_warn:  document.getElementById('edit-ram-warn'),
  ram_crit:  document.getElementById('edit-ram-crit'),
  disk_warn: document.getElementById('edit-disk-warn'),
  disk_crit: document.getElementById('edit-disk-crit'),
};
let editingHostId = null;

// id -> window ('1h'|'24h'|'7d'|'30d') for hosts whose chart panel is open
const expanded = new Map();
// id -> { pct: Chart, load: Chart } so we can destroy them before re-rendering
const charts = new Map();
// Set of host ids whose details panel is open
const detailsOpen = new Set();
// id -> last details payload (cached so loadHosts() can re-render without a new SSH fetch)
const detailsCache = new Map();

const alertsBtn      = document.getElementById('alerts-button');
const alertsCountEl  = document.getElementById('alerts-count');
const alertsDropdown = document.getElementById('alerts-dropdown');
const alertsListEl   = document.getElementById('alerts-list');
// host_id -> highest level among its active alerts ('warning' | 'critical')
let activeAlertsByHost = new Map();

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

function alertMetricLabel(metric) {
  if (metric === 'status') return 'host DOWN';
  if (metric === 'cpu') return 'CPU';
  if (metric === 'ram') return 'RAM';
  if (metric === 'disk') return 'Disk';
  return metric;
}

async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (!res.ok) return;
    const { alerts } = await res.json();
    renderAlerts(alerts || []);
  } catch { /* keep last-known state */ }
}

function renderAlerts(alerts) {
  // Update per-host map (highest level wins: critical > warning).
  const byHost = new Map();
  for (const a of alerts) {
    const prev = byHost.get(a.host_id);
    if (prev !== 'critical') byHost.set(a.host_id, a.level);
  }
  activeAlertsByHost = byHost;

  // Badge counter.
  if (alerts.length === 0) {
    alertsBtn.classList.remove('has-alerts', 'has-critical');
    alertsCountEl.hidden = true;
  } else {
    alertsBtn.classList.add('has-alerts');
    if (alerts.some((a) => a.level === 'critical')) {
      alertsBtn.classList.add('has-critical');
    } else {
      alertsBtn.classList.remove('has-critical');
    }
    alertsCountEl.hidden = false;
    alertsCountEl.textContent = String(alerts.length);
  }

  // Dropdown content.
  if (alerts.length === 0) {
    alertsListEl.innerHTML = '<p class="alerts-empty">No active alerts.</p>';
  } else {
    alertsListEl.innerHTML = alerts.map((a) => {
      const valueText = a.value != null && !isNaN(a.value)
        ? `${a.value.toFixed(1)}% (≥ ${a.threshold}%)`
        : '';
      return `
        <div class="alert-row alert-${a.level}">
          <span class="alert-level">${a.level}</span>
          <div class="alert-body">
            <div class="alert-host">${escapeHTML(a.name || a.ip)}</div>
            <div class="alert-meta">${escapeHTML(alertMetricLabel(a.metric))}${valueText ? ` · ${valueText}` : ''} · ${escapeHTML(relativeTime(a.fired_at))}</div>
          </div>
        </div>`;
    }).join('');
  }
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

  const alertLevel = activeAlertsByHost.get(h.id);
  const alertBadge = alertLevel
    ? `<span class="card-alert alert-${alertLevel}" title="${alertLevel} alert active">!</span>`
    : '';

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
  const detailsToggle = h.check_type === 'ssh'
    ? `<button class="details-toggle" data-id="${h.id}" title="Toggle details">details</button>`
    : '';
  const editBtn = `<button class="edit-host" data-id="${h.id}" title="Edit host" aria-label="Edit host">edit</button>`;
  const hasOverride = h.check_type === 'ssh' && (
    h.cpu_warn != null || h.cpu_crit != null ||
    h.ram_warn != null || h.ram_crit != null ||
    h.disk_warn != null || h.disk_crit != null
  );
  const overrideBadge = hasOverride
    ? `<span class="override-badge" title="Per-host thresholds set">th</span>`
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

  const detailsPanel = h.check_type === 'ssh'
    ? `
      <div class="details-panel" id="details-panel-${h.id}"${detailsOpen.has(h.id) ? '' : ' hidden'}>
        <div class="details-actions">
          <button class="details-refresh" data-id="${h.id}">refresh</button>
        </div>
        <div class="details-body" id="details-body-${h.id}"><p class="details-loading">loading…</p></div>
      </div>`
    : '';

  return `
    <article class="card ${statusClass}">
      <header>
        <span class="dot"></span>
        <span class="status">${statusText}</span>
        ${alertBadge}
        ${overrideBadge}
        <span class="mode">${mode}</span>
        ${detailsToggle}
        ${chartToggle}
        ${editBtn}
        <button class="delete" data-id="${h.id}" title="Remove host" aria-label="Remove host">x</button>
      </header>
      <h2>${title}</h2>
      ${sub}
      ${metricsHtml}
      ${detailsPanel}
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

function humanBytes(n) {
  if (n == null || isNaN(n)) return '--';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function renderDetails(id, data) {
  const body = document.getElementById(`details-body-${id}`);
  if (!body) return;

  let svcHtml = '';
  if (data.services && data.services.length) {
    svcHtml = `
      <h3 class="details-h">services</h3>
      <ul class="svc-list">
        ${data.services.map((s) => {
          const state = (s.state || 'unknown').toLowerCase();
          const cls = state === 'active' ? 'svc-active'
                    : state === 'inactive' ? 'svc-inactive'
                    : state === 'failed' ? 'svc-failed'
                    : 'svc-unknown';
          return `<li class="svc-item ${cls}"><span class="svc-name">${escapeHTML(s.name)}</span><span class="svc-state">${escapeHTML(state)}</span></li>`;
        }).join('')}
      </ul>`;
  } else {
    svcHtml = `<p class="details-empty">No services configured. Edit the host to add some.</p>`;
  }

  let procHtml = '';
  if (data.top_processes && data.top_processes.length) {
    procHtml = `
      <h3 class="details-h">top processes</h3>
      <table class="proc-table">
        <thead><tr><th>user</th><th>pid</th><th>cpu%</th><th>ram%</th><th>command</th></tr></thead>
        <tbody>
          ${data.top_processes.map((p) => `
            <tr>
              <td>${escapeHTML(p.user)}</td>
              <td>${p.pid}</td>
              <td>${isNaN(p.cpu) ? '--' : p.cpu.toFixed(1)}</td>
              <td>${isNaN(p.ram) ? '--' : p.ram.toFixed(1)}</td>
              <td class="proc-cmd">${escapeHTML(p.command)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  let userHtml = '';
  if (data.users && data.users.length) {
    userHtml = `
      <h3 class="details-h">logged-in users</h3>
      <table class="user-table">
        <thead><tr><th>user</th><th>tty</th><th>from</th></tr></thead>
        <tbody>
          ${data.users.map((u) => `
            <tr>
              <td>${escapeHTML(u.user)}</td>
              <td>${escapeHTML(u.tty || '--')}</td>
              <td>${escapeHTML(u.from || 'local')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else {
    userHtml = `<h3 class="details-h">logged-in users</h3><p class="details-empty">No interactive sessions.</p>`;
  }

  let netHtml = '';
  if (data.network) {
    netHtml = `
      <h3 class="details-h">network</h3>
      <div class="net-block">
        <div class="net-iface">interface <span class="net-iface-name">${escapeHTML(data.network.interface)}</span></div>
        <div class="net-stats">
          <div class="net-stat"><span class="net-stat-label">RX</span><span class="net-stat-value">${humanBytes(data.network.rx_bytes)}</span></div>
          <div class="net-stat"><span class="net-stat-label">TX</span><span class="net-stat-value">${humanBytes(data.network.tx_bytes)}</span></div>
        </div>
      </div>`;
  }

  body.innerHTML = svcHtml + procHtml + userHtml + netHtml;
}

async function loadDetails(id) {
  const body = document.getElementById(`details-body-${id}`);
  if (body) body.innerHTML = '<p class="details-loading">loading…</p>';
  try {
    const res = await fetch(`/api/hosts/${id}/details`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (body) body.innerHTML = `<p class="details-error">${escapeHTML(data.error || 'Failed to load details')}</p>`;
      return;
    }
    const data = await res.json();
    detailsCache.set(id, data);
    renderDetails(id, data);
  } catch {
    if (body) body.innerHTML = '<p class="details-error">Network error</p>';
  }
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
    for (const id of detailsOpen) {
      if (!liveIds.has(id)) {
        detailsOpen.delete(id);
        detailsCache.delete(id);
        continue;
      }
      const cached = detailsCache.get(id);
      if (cached) renderDetails(id, cached);
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
      const numId = parseInt(id, 10);
      expanded.delete(numId);
      detailsOpen.delete(numId);
      detailsCache.delete(numId);
      loadHosts();
    } catch {
      showError('Could not delete host');
    }
    return;
  }

  const detailsBtn = e.target.closest('.details-toggle');
  if (detailsBtn) {
    const id = parseInt(detailsBtn.dataset.id, 10);
    const panel = document.getElementById(`details-panel-${id}`);
    if (!panel) return;
    if (detailsOpen.has(id)) {
      detailsOpen.delete(id);
      panel.hidden = true;
    } else {
      detailsOpen.add(id);
      panel.hidden = false;
      const cached = detailsCache.get(id);
      if (cached) renderDetails(id, cached); else loadDetails(id);
    }
    return;
  }

  const refreshBtn = e.target.closest('.details-refresh');
  if (refreshBtn) {
    const id = parseInt(refreshBtn.dataset.id, 10);
    loadDetails(id);
    return;
  }

  const editBtn = e.target.closest('.edit-host');
  if (editBtn) {
    openEditDialog(parseInt(editBtn.dataset.id, 10));
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

let lastCheckType = checkType.value;
function updateFormFields() {
  const t = checkType.value;
  userInput.hidden = (t !== 'ssh');
  portInput.hidden = (t === 'icmp');
  servicesInput.hidden = (t !== 'ssh');
  advancedToggle.hidden = (t !== 'ssh');
  userInput.required = (t === 'ssh');
  portInput.required = (t === 'tcp');
  portInput.placeholder = (t === 'ssh') ? 'port (default 22)' : 'port';
  if (t !== 'ssh') {
    userInput.value = '';
    servicesInput.value = '';
    closeAdvanced();
    for (const inp of Object.values(thresholdInputs)) inp.value = '';
  }
  // Wipe the port whenever the check type changes — the meaning of "port"
  // differs between TCP (required) and SSH (defaults to 22), so a stale value
  // from a previous selection would silently target the wrong port.
  if (t !== lastCheckType) portInput.value = '';
  lastCheckType = t;
}
checkType.addEventListener('change', updateFormFields);
updateFormFields();

function openAdvanced() {
  advancedBlock.hidden = false;
  advancedToggle.setAttribute('aria-expanded', 'true');
  advancedToggle.textContent = '− thresholds';
}
function closeAdvanced() {
  advancedBlock.hidden = true;
  advancedToggle.setAttribute('aria-expanded', 'false');
  advancedToggle.textContent = '+ thresholds';
}
advancedToggle.addEventListener('click', () => {
  if (advancedBlock.hidden) openAdvanced(); else closeAdvanced();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip       = ipInput.value.trim();
  const type     = checkType.value;
  const user     = userInput.value.trim();
  const port     = portInput.value.trim();
  const services = servicesInput.value.trim();
  const name     = nameInput.value.trim();
  if (!ip) return;
  const payload = {
    ip,
    name: name || undefined,
    port: port || undefined,
    check_type: type,
    ssh_user: user || undefined,
    services: services || undefined,
  };
  if (type === 'ssh') {
    for (const [key, inp] of Object.entries(thresholdInputs)) {
      const v = inp.value.trim();
      if (v !== '') payload[key] = v;
    }
  }
  try {
    const res = await fetch('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not add host');
      return;
    }
    ipInput.value = '';
    userInput.value = '';
    portInput.value = '';
    servicesInput.value = '';
    nameInput.value = '';
    for (const inp of Object.values(thresholdInputs)) inp.value = '';
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

alertsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !alertsDropdown.hidden;
  alertsDropdown.hidden = open;
  alertsBtn.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!alertsDropdown.hidden && !e.target.closest('#alerts-bell')) {
    alertsDropdown.hidden = true;
    alertsBtn.setAttribute('aria-expanded', 'false');
  }
});

function openEditDialog(id) {
  // We pull the latest snapshot from /api/hosts rather than caching, so
  // values shown in the dialog match what the server currently has.
  fetch('/api/hosts')
    .then((r) => r.json())
    .then((hosts) => {
      const h = hosts.find((x) => x.id === id);
      if (!h) { showError('Host not found'); return; }
      editingHostId = id;
      const target = h.check_type === 'ssh'
        ? `${h.ssh_user}@${h.ip}${h.port ? ':' + h.port : ''}`
        : (h.port ? `${h.ip}:${h.port}` : h.ip);
      editTarget.textContent = `${target} · ${h.check_type.toUpperCase()}`;

      editName.value     = h.name || '';
      editPort.value     = h.port != null ? String(h.port) : '';
      editUser.value     = h.ssh_user || '';
      editServices.value = h.services || '';
      for (const [key, inp] of Object.entries(editThresholdInputs)) {
        inp.value = h[key] != null ? String(h[key]) : '';
      }

      const ssh = h.check_type === 'ssh';
      editPortRow.hidden       = h.check_type === 'icmp';
      editUserRow.hidden       = !ssh;
      editServicesRow.hidden   = !ssh;
      editThresholdsRow.hidden = !ssh;

      editError.hidden = true;
      editError.textContent = '';
      editDialog.showModal();
    })
    .catch(() => showError('Could not load host'));
}

editCancel.addEventListener('click', () => {
  editDialog.close();
  editingHostId = null;
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (editingHostId == null) return;

  const body = {
    name: editName.value.trim() || null,
  };
  if (!editPortRow.hidden) {
    body.port = editPort.value.trim() || null;
  }
  if (!editUserRow.hidden) {
    body.ssh_user = editUser.value.trim();
  }
  if (!editServicesRow.hidden) {
    body.services = editServices.value.trim();
  }
  if (!editThresholdsRow.hidden) {
    for (const [key, inp] of Object.entries(editThresholdInputs)) {
      body[key] = inp.value.trim();
    }
  }

  try {
    const res = await fetch(`/api/hosts/${editingHostId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      editError.textContent = data.error || 'Could not save changes';
      editError.hidden = false;
      return;
    }
    editDialog.close();
    editingHostId = null;
    loadHosts();
  } catch {
    editError.textContent = 'Network error';
    editError.hidden = false;
  }
});

loadConfig();
loadAlerts();
loadHosts();
setInterval(loadHosts,  5000);
setInterval(loadAlerts, 7000);
