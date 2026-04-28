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

const discoveryLabel = document.getElementById('discovery-label');
const discoveryInput = document.getElementById('discovery-input');

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

const windowsHost = document.getElementById('windows-host');

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

// host id -> window ('1h'|'24h'|'7d'|'30d'), remembered across re-opens
const expanded = new Map();
// host id -> { pct: Chart, load: Chart } — kept so we can destroy before redraw
const charts = new Map();
// host id -> last details payload (cached so re-opens skip the SSH round-trip)
const detailsCache = new Map();
// host id -> last discovered VMs payload
const discoverCache = new Map();

// Floating-window registry. Each entry: { id, type, hostId, el, body }.
// `id` is a per-window unique key like "chart-12" so opening the same
// chart twice just brings the existing one to front.
const fwRegistry = new Map();
let fwTopZ = 100;
// Cascading offset for newly-opened windows so they don't all stack on
// top of each other when the user opens several in a row.
let fwSpawnOffset = 0;

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
  const parentTag = h.parent_id
    ? `<span class="parent-tag" title="Discovered from ${escapeHTML(h.parent_name || '')}">via ${escapeHTML(h.parent_name || ('#' + h.parent_id))}</span>`
    : '';
  const subInner = h.name ? escapeHTML(targetDisplay) : '';
  const sub = (subInner || parentTag)
    ? `<p class="ip">${subInner}${subInner && parentTag ? ' &middot; ' : ''}${parentTag}</p>`
    : '';

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

  const hasOverride = h.check_type === 'ssh' && (
    h.cpu_warn != null || h.cpu_crit != null ||
    h.ram_warn != null || h.ram_crit != null ||
    h.disk_warn != null || h.disk_crit != null
  );
  const overrideBadge = hasOverride
    ? `<span class="override-badge" title="Per-host thresholds set">th</span>`
    : '';
  // Build the kebab-menu items based on what makes sense for this host.
  // SSH-only actions stay hidden for ICMP/TCP hosts so the menu stays tight.
  const menuItems = [];
  if (h.check_type === 'ssh') {
    menuItems.push(`<button class="card-menu-item" data-id="${h.id}" data-action="chart">chart</button>`);
    menuItems.push(`<button class="card-menu-item" data-id="${h.id}" data-action="details">details</button>`);
  }
  if (h.discovery === 'proxmox') {
    menuItems.push(`<button class="card-menu-item" data-id="${h.id}" data-action="discover">discover</button>`);
  }
  menuItems.push(`<button class="card-menu-item" data-id="${h.id}" data-action="edit">edit</button>`);
  menuItems.push(`<button class="card-menu-item card-menu-danger" data-id="${h.id}" data-action="delete">delete</button>`);
  // Kebab + popup menu, anchored to the card header. The wrapper gets
  // position:relative so the floating list pins to the button.
  const cardMenu = `
    <div class="card-menu">
      <button class="card-menu-btn" data-id="${h.id}" aria-haspopup="menu" aria-expanded="false" aria-label="Card actions">⋯</button>
      <div class="card-menu-list" id="card-menu-${h.id}" role="menu" hidden>
        ${menuItems.join('')}
      </div>
    </div>`;

  return `
    <article class="card ${statusClass}">
      <header>
        <span class="dot"></span>
        <span class="status">${statusText}</span>
        ${alertBadge}
        ${overrideBadge}
        <span class="mode">${mode}</span>
        ${cardMenu}
      </header>
      <h2>${title}</h2>
      ${sub}
      ${metricsHtml}
      <footer>
        <span class="latency">${latency}</span>
        <span class="checked">${relativeTime(h.last_ts)}</span>
      </footer>
    </article>
  `;
}

// We only ever draw one chart at a time now (it lives in the modal), but
// keep the per-host map so re-opens don't leak Chart.js instances.
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
  const w = fwRegistry.get(`details-${id}`);
  if (!w) return;
  const body = w.body;
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
  const w = fwRegistry.get(`details-${id}`);
  const body = w ? w.body : null;
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

function renderDiscover(id, data) {
  const w = fwRegistry.get(`discover-${id}`);
  if (!w) return;
  const body = w.body;
  if (!body) return;
  const vms = (data && data.vms) || [];
  if (!vms.length) {
    body.innerHTML = '<p class="details-empty">No VMs or containers found on this Proxmox node.</p>';
    return;
  }
  const rows = vms.map((v) => {
    const ipDisplay = v.ip ? escapeHTML(v.ip) : '<span class="discover-no-ip">no IP</span>';
    const disabled  = v.ip ? '' : ' disabled';
    return `
      <tr class="discover-row${v.ip ? '' : ' discover-row-noip'}">
        <td><input type="checkbox" class="discover-pick" data-id="${id}" data-vmid="${v.vmid}"${disabled}></td>
        <td>${v.vmid}</td>
        <td>${escapeHTML(v.type)}</td>
        <td>${escapeHTML(v.name)}</td>
        <td>${escapeHTML(v.status)}</td>
        <td>${ipDisplay}</td>
      </tr>`;
  }).join('');
  body.innerHTML = `
    <table class="discover-table">
      <thead><tr><th></th><th>vmid</th><th>type</th><th>name</th><th>status</th><th>ip</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="discover-adopt">
      <input type="text" class="discover-user" data-id="${id}" placeholder="ssh user for adopted hosts" autocomplete="off">
      <button class="discover-adopt-btn" data-id="${id}">adopt selected</button>
    </div>
    <p class="discover-error" id="discover-error-${id}" hidden></p>
  `;
}

async function loadDiscover(id) {
  const w = fwRegistry.get(`discover-${id}`);
  const body = w ? w.body : null;
  if (body) body.innerHTML = '<p class="details-loading">probing…</p>';
  try {
    const res = await fetch(`/api/hosts/${id}/discover`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (body) body.innerHTML = `<p class="details-error">${escapeHTML(data.error || 'Discovery failed')}</p>`;
      return;
    }
    const data = await res.json();
    discoverCache.set(id, data);
    renderDiscover(id, data);
  } catch {
    if (body) body.innerHTML = '<p class="details-error">Network error</p>';
  }
}

async function adoptSelected(id) {
  const w = fwRegistry.get(`discover-${id}`);
  const panel = w ? w.body : null;
  if (!panel) return;
  const userInput = panel.querySelector('.discover-user');
  const errEl     = document.getElementById(`discover-error-${id}`);
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  const sshUser = userInput ? userInput.value.trim() : '';
  if (!sshUser) {
    if (errEl) { errEl.textContent = 'SSH user is required'; errEl.hidden = false; }
    return;
  }
  const cached = discoverCache.get(id);
  const all = (cached && cached.vms) || [];
  const picked = [...panel.querySelectorAll('.discover-pick:checked')]
    .map((cb) => parseInt(cb.dataset.vmid, 10));
  const vms = all.filter((v) => picked.includes(v.vmid) && v.ip);
  if (!vms.length) {
    if (errEl) { errEl.textContent = 'Pick at least one VM with an IP'; errEl.hidden = false; }
    return;
  }
  try {
    const res = await fetch(`/api/hosts/${id}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssh_user: sshUser, vms }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) { errEl.textContent = data.error || 'Adoption failed'; errEl.hidden = false; }
      return;
    }
    // Skipped reasons (UNIQUE collisions, no IP) are surfaced inline so the user
    // doesn't silently lose VMs they thought they were adopting.
    if (data.skipped && data.skipped.length && errEl) {
      errEl.textContent = `Skipped: ${data.skipped.map((s) => s.vmid + ' (' + s.reason + ')').join(', ')}`;
      errEl.hidden = false;
    }
    closeFloatingWindow(`discover-${id}`);
    discoverCache.delete(id);
    loadHosts();
  } catch {
    if (errEl) { errEl.textContent = 'Network error'; errEl.hidden = false; }
  }
}

async function loadHosts() {
  try {
    const res = await fetch('/api/hosts');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const hosts = await res.json();

    if (hosts.length === 0) {
      hostsEl.innerHTML = '<p class="empty">No hosts yet. Add one above.</p>';
    } else {
      hostsEl.innerHTML = hosts.map(renderHost).join('');
    }

    // The dialogs live outside `hostsEl` so they survive this innerHTML
    // reflow — no panel restoration needed. We do clean up state for hosts
    // that no longer exist (e.g. someone deleted a host while a dialog
    // referencing it was somehow still open in another tab).
    const liveIds = new Set(hosts.map((h) => h.id));
    for (const id of [...detailsCache.keys()])  if (!liveIds.has(id)) detailsCache.delete(id);
    for (const id of [...discoverCache.keys()]) if (!liveIds.has(id)) discoverCache.delete(id);
    for (const id of [...expanded.keys()])      if (!liveIds.has(id)) expanded.delete(id);
    // Close any floating windows whose host has just been deleted.
    for (const w of [...fwRegistry.values()]) {
      if (!liveIds.has(w.hostId)) closeFloatingWindow(w.key);
    }
  } catch (e) {
    console.error('loadHosts failed:', e);
    showError('Could not load hosts: ' + (e && e.message ? e.message : e));
  }
}

function findHostName(id) {
  const card = document.querySelector(`.card-menu-btn[data-id="${id}"]`);
  if (!card) return `#${id}`;
  const h2 = card.closest('article.card')?.querySelector('h2');
  return h2 ? h2.textContent : `#${id}`;
}

function closeAllCardMenus() {
  document.querySelectorAll('.card-menu-list').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('.card-menu-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function bringToFront(el) {
  fwTopZ += 1;
  el.style.zIndex = String(fwTopZ);
}

// Drag-by-header: any mousedown on a non-button area of the window header
// captures the cursor and moves the window. Mouse leaves grid via document
// listeners so dragging fast off the title still works.
function makeDraggable(el, handle) {
  let dx = 0, dy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, select')) return;
    bringToFront(el);
    const rect = el.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    el.classList.add('fw-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    e.preventDefault();
  });
  function onMove(e) {
    // No clamp on purpose — the user can drag the window anywhere within
    // the browser viewport, including right up against (and past) the edges
    // if the browser spans multiple monitors. For real multi-monitor moves
    // across separate browser windows, use the pop-out button.
    el.style.left = (e.clientX - dx) + 'px';
    el.style.top  = (e.clientY - dy) + 'px';
  }
  function onUp() {
    el.classList.remove('fw-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
}

// Build a floating window. Returns { el, body, titleEl, headerActions } so
// callers can inject the right contents/refresh button per type.
function createFloatingWindow({ key, title, hostId, type, width, onClose }) {
  // If a window with the same key (e.g. "chart-12") already exists, just
  // bring it to front instead of opening a duplicate.
  const existing = fwRegistry.get(key);
  if (existing) { bringToFront(existing.el); return null; }

  const el = document.createElement('div');
  el.className = 'fw';
  el.dataset.key = key;
  if (width) el.style.width = width;
  // Cascade spawn position so consecutive opens don't fully overlap.
  fwSpawnOffset = (fwSpawnOffset + 28) % 200;
  const startX = Math.max(40, Math.round(window.innerWidth  / 2 - 360 + fwSpawnOffset));
  const startY = Math.max(40, 80 + fwSpawnOffset);
  el.style.left = startX + 'px';
  el.style.top  = startY + 'px';

  el.innerHTML = `
    <div class="fw-header">
      <h2 class="fw-title"></h2>
      <div class="fw-header-actions"></div>
      <button type="button" class="fw-popout" title="Open in separate browser window (drag to another monitor)" aria-label="Pop out">↗</button>
      <button type="button" class="fw-close" aria-label="Close">x</button>
    </div>
    <div class="fw-body"></div>`;

  const titleEl       = el.querySelector('.fw-title');
  const headerActions = el.querySelector('.fw-header-actions');
  const body          = el.querySelector('.fw-body');
  const header        = el.querySelector('.fw-header');
  titleEl.textContent = title;

  el.querySelector('.fw-close').addEventListener('click', () => closeFloatingWindow(key));
  el.querySelector('.fw-popout').addEventListener('click', () => popOutWindow(key));
  el.addEventListener('mousedown', () => bringToFront(el));
  makeDraggable(el, header);

  windowsHost.appendChild(el);
  bringToFront(el);

  fwRegistry.set(key, { key, type, hostId, el, body, titleEl, headerActions, onClose });
  return fwRegistry.get(key);
}

function closeFloatingWindow(key) {
  const w = fwRegistry.get(key);
  if (!w) return;
  if (typeof w.onClose === 'function') w.onClose();
  w.el.remove();
  fwRegistry.delete(key);
}

// Open the same view as a real browser window — the OS chrome handles the
// drag (including across monitors), resize, fullscreen, etc. The popup
// loads index.html?window=<type>&host=<id>, which app.js detects below
// and runs in a stripped-down popup mode that fills the whole window.
function popOutWindow(key) {
  const w = fwRegistry.get(key);
  if (!w) return;
  const url = `/?window=${w.type}&host=${w.hostId}`;
  // The named target makes a second click reuse the existing OS window
  // instead of opening yet another one.
  const popup = window.open(url, `didactic-${key}`, 'width=900,height=620,resizable=yes,scrollbars=yes');
  if (!popup) {
    showError('Pop-out blocked — allow popups for this site to use this feature');
    return;
  }
  closeFloatingWindow(key);
}

function closeWindowsForHost(hostId) {
  for (const [key, w] of fwRegistry) {
    if (w.hostId === hostId) closeFloatingWindow(key);
  }
}

function openChartWindow(id) {
  const key = `chart-${id}`;
  if (!expanded.has(id)) expanded.set(id, '1h');
  const w = createFloatingWindow({
    key,
    type: 'chart',
    hostId: id,
    title: `history — ${findHostName(id)}`,
    width: '780px',
    onClose: () => destroyCharts(id),
  });
  if (!w) return; // already open, brought to front
  // Window picker + canvases.
  w.body.innerHTML = `
    <div class="window-picker"></div>
    <canvas class="chart-pct"  id="chart-pct-${id}"></canvas>
    <canvas class="chart-load" id="chart-load-${id}"></canvas>`;
  const picker = w.body.querySelector('.window-picker');
  const renderPicker = () => {
    const active = expanded.get(id) || '1h';
    picker.innerHTML = ['1h', '24h', '7d', '30d']
      .map((p) => `<button data-window="${p}" class="win-btn${p === active ? ' active' : ''}">${p}</button>`)
      .join('');
  };
  renderPicker();
  picker.addEventListener('click', (e) => {
    const wb = e.target.closest('.win-btn');
    if (!wb) return;
    expanded.set(id, wb.dataset.window);
    renderPicker();
    drawChart(id);
  });
  drawChart(id);
}

function openDetailsWindow(id) {
  const key = `details-${id}`;
  const w = createFloatingWindow({
    key,
    type: 'details',
    hostId: id,
    title: `details — ${findHostName(id)}`,
    width: '720px',
  });
  if (!w) return;
  // Refresh button in the header so users can re-probe without losing position.
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'fw-action';
  refresh.textContent = 'refresh';
  refresh.addEventListener('click', () => loadDetails(id));
  w.headerActions.appendChild(refresh);
  w.body.innerHTML = '<p class="details-loading">loading…</p>';
  const cached = detailsCache.get(id);
  if (cached) renderDetails(id, cached);
  else loadDetails(id);
}

function openDiscoverWindow(id) {
  const key = `discover-${id}`;
  const w = createFloatingWindow({
    key,
    type: 'discover',
    hostId: id,
    title: `discover — ${findHostName(id)}`,
    width: '760px',
  });
  if (!w) return;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'fw-action';
  refresh.textContent = 'refresh';
  refresh.addEventListener('click', () => loadDiscover(id));
  w.headerActions.appendChild(refresh);
  w.body.innerHTML = '<p class="details-loading">probing…</p>';
  // Adopt button lives inside the rendered table; delegate clicks here.
  w.body.addEventListener('click', (e) => {
    if (e.target.closest('.discover-adopt-btn')) adoptSelected(id);
  });
  const cached = discoverCache.get(id);
  if (cached) renderDiscover(id, cached);
  else loadDiscover(id);
}

async function deleteHost(id) {
  if (!confirm('Remove this host?')) return;
  try {
    const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    expanded.delete(id);
    detailsCache.delete(id);
    discoverCache.delete(id);
    closeWindowsForHost(id);
    loadHosts();
  } catch {
    showError('Could not delete host');
  }
}

hostsEl.addEventListener('click', (e) => {
  // Kebab-menu toggle: open the dropdown for this card and close the others.
  const menuBtn = e.target.closest('.card-menu-btn');
  if (menuBtn) {
    const id = parseInt(menuBtn.dataset.id, 10);
    const list = document.getElementById(`card-menu-${id}`);
    const willOpen = list && list.hidden;
    closeAllCardMenus();
    if (willOpen) {
      list.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
    }
    e.stopPropagation();
    return;
  }

  // One handler for every kebab item, dispatched by data-action.
  const item = e.target.closest('.card-menu-item');
  if (item) {
    const id = parseInt(item.dataset.id, 10);
    closeAllCardMenus();
    switch (item.dataset.action) {
      case 'chart':    openChartWindow(id); break;
      case 'details':  openDetailsWindow(id); break;
      case 'discover': openDiscoverWindow(id); break;
      case 'edit':     openEditDialog(id); break;
      case 'delete':   deleteHost(id); break;
    }
    return;
  }

  // Buttons inside the discover dialog body — adopt and refresh — bubble up
  // to a document-level listener below since they live outside `hostsEl`.
});

// Click outside any kebab menu closes them all.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-menu')) closeAllCardMenus();
});

// Per-window close / refresh / adopt / window-picker handlers all live
// inside createFloatingWindow + the open*Window functions, so there are
// no more single-shared listeners to maintain here.

let lastCheckType = checkType.value;
function updateFormFields() {
  const t = checkType.value;
  userInput.hidden = (t !== 'ssh');
  portInput.hidden = (t === 'icmp');
  servicesInput.hidden = (t !== 'ssh');
  advancedToggle.hidden = (t !== 'ssh');
  discoveryLabel.hidden = (t !== 'ssh');
  userInput.required = (t === 'ssh');
  portInput.required = (t === 'tcp');
  portInput.placeholder = (t === 'ssh') ? 'port (default 22)' : 'port';
  if (t !== 'ssh') {
    userInput.value = '';
    servicesInput.value = '';
    discoveryInput.checked = false;
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
    if (discoveryInput.checked) payload.discovery = 'proxmox';
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
    discoveryInput.checked = false;
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

// Pop-out / standalone mode: when the URL has ?window=<type>&host=<id>,
// hide the dashboard chrome and only show that one floating window
// stretched to fill the browser window. The OS handles dragging this
// browser window between monitors natively.
async function maybeRunPopupMode() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get('window');
  const id   = parseInt(params.get('host'), 10);
  if (!['chart', 'details', 'discover'].includes(type) || !Number.isFinite(id)) return false;

  document.body.classList.add('popup-mode');

  let hostName = `#${id}`;
  try {
    const res = await fetch('/api/hosts');
    if (res.ok) {
      const hosts = await res.json();
      const h = hosts.find((x) => x.id === id);
      if (h) hostName = h.name || h.ip;
    }
  } catch { /* fall through */ }
  document.title = `${type} — ${hostName}`;

  // Reuse the open*Window functions. We can't rely on findHostName()
  // because the cards aren't rendered in popup mode, so monkey-patch a
  // single-shot lookup for the title.
  const realFindHostName = findHostName;
  window.findHostName = () => hostName; // not used — left for clarity

  if (type === 'chart')    openChartWindow(id);
  if (type === 'details')  openDetailsWindow(id);
  if (type === 'discover') openDiscoverWindow(id);

  // Fix the title (open*Window above used findHostName which returned #id).
  const w = fwRegistry.get(`${type}-${id}`);
  if (w) {
    w.titleEl.textContent = `${type} — ${hostName}`;
    w.el.classList.add('fw-popup');
    // The OS window already has a close button; the in-app close + pop-out
    // make no sense in this mode.
    w.el.querySelector('.fw-close').remove();
    w.el.querySelector('.fw-popout').remove();
  }
  return true;
}

(async () => {
  if (await maybeRunPopupMode()) return;
  loadConfig();
  loadAlerts();
  loadHosts();
  setInterval(loadHosts,  15000);
  setInterval(loadAlerts, 7000);
})();
