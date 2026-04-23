const hostsEl   = document.getElementById('hosts');
const errorBox  = document.getElementById('error-box');
const form      = document.getElementById('add-form');
const ipInput   = document.getElementById('ip-input');
const portInput = document.getElementById('port-input');
const nameInput = document.getElementById('name-input');

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

function renderHost(h) {
  let statusClass = 'unknown';
  let statusText  = 'UNKNOWN';
  if (h.last_ts != null) {
    if (h.last_ok) { statusClass = 'up';   statusText = 'UP'; }
    else           { statusClass = 'down'; statusText = 'DOWN'; }
  }
  const latency = h.last_ok && h.last_latency != null
    ? `${h.last_latency.toFixed(1)} ms`
    : '--';
  const target = h.port ? `${h.ip}:${h.port}` : h.ip;
  const mode   = h.port ? `TCP/${h.port}` : 'ICMP';
  const title  = h.name ? escapeHTML(h.name) : escapeHTML(target);
  const subip  = h.name ? `<p class="ip">${escapeHTML(target)}</p>` : '';
  return `
    <article class="card ${statusClass}">
      <header>
        <span class="dot"></span>
        <span class="status">${statusText}</span>
        <span class="mode">${mode}</span>
        <button class="delete" data-id="${h.id}" title="Remove host" aria-label="Remove host">x</button>
      </header>
      <h2>${title}</h2>
      ${subip}
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip   = ipInput.value.trim();
  const name = nameInput.value.trim();
  const port = portInput.value.trim();
  if (!ip) return;
  try {
    const res = await fetch('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip,
        name: name || undefined,
        port: port || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not add host');
      return;
    }
    ipInput.value = '';
    portInput.value = '';
    nameInput.value = '';
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
