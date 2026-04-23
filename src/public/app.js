const hostsEl    = document.getElementById('hosts');
const errorBox   = document.getElementById('error-box');
const form       = document.getElementById('add-form');
const ipInput    = document.getElementById('ip-input');
const checkType  = document.getElementById('check-type');
const userInput  = document.getElementById('user-input');
const portInput  = document.getElementById('port-input');
const nameInput  = document.getElementById('name-input');

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

  return `
    <article class="card ${statusClass}">
      <header>
        <span class="dot"></span>
        <span class="status">${statusText}</span>
        <span class="mode">${mode}</span>
        <button class="delete" data-id="${h.id}" title="Remove host" aria-label="Remove host">x</button>
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

async function loadHosts() {
  try {
    const res = await fetch('/api/hosts');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const hosts = await res.json();
    if (hosts.length === 0) {
      hostsEl.innerHTML = '<p class="empty">No hosts yet. Add one above.</p>';
      return;
    }
    hostsEl.innerHTML = hosts.map(renderHost).join('');
  } catch {
    showError('Could not load hosts');
  }
}

hostsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.delete');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm('Remove this host?')) return;
  try {
    const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    loadHosts();
  } catch {
    showError('Could not delete host');
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

loadHosts();
setInterval(loadHosts, 5000);
