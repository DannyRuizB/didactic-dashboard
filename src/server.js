const express = require('express');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const nodemailer = require('nodemailer');
const db = require('./db');

const PORT           = parseInt(process.env.PORT          || '3000',  10);
const PING_INTERVAL  = parseInt(process.env.PING_INTERVAL || '10000', 10);
const DEMO_MODE      = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
const DEMO_MAX_HOSTS = parseInt(process.env.DEMO_MAX_HOSTS || '15', 10);

const ALERT_THRESHOLDS = {
  cpu:  { warning: parseFloat(process.env.CPU_WARN  || '70'), critical: parseFloat(process.env.CPU_CRIT  || '90') },
  ram:  { warning: parseFloat(process.env.RAM_WARN  || '80'), critical: parseFloat(process.env.RAM_CRIT  || '95') },
  disk: { warning: parseFloat(process.env.DISK_WARN || '80'), critical: parseFloat(process.env.DISK_CRIT || '90') },
};
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const ALERT_DOWN_AFTER  = parseInt(process.env.ALERT_DOWN_AFTER || '2', 10);

const SMTP_HOST   = process.env.SMTP_HOST   || '';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER   = process.env.SMTP_USER   || '';
const SMTP_PASS   = process.env.SMTP_PASS   || '';
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || SMTP_USER;
const ALERT_EMAIL_TO   = process.env.ALERT_EMAIL_TO   || '';

const emailEnabled = !!SMTP_HOST && !!ALERT_EMAIL_TO;
const mailer = emailEnabled
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

const DEMO_SEEDS = [];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isValidTarget(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 253) return false;
  return /^[a-zA-Z0-9.\-_]+$/.test(str);
}

function isValidSshUser(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 32) return false;
  return /^[a-zA-Z0-9._-]+$/.test(str);
}

function parseServices(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  if (raw.length > 512) return { ok: false };
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length > 20) return { ok: false };
  for (const s of items) {
    if (s.length > 64) return { ok: false };
    if (!/^[a-zA-Z0-9._@-]+$/.test(s)) return { ok: false };
  }
  return { ok: true, value: items.length ? items.join(',') : null };
}

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

// Per-host threshold override: a number 0-100 (one decimal accepted) or null
// when the user wants to fall back to the global env var. Returns `undefined`
// to signal "invalid input" so the caller can return 400.
function parseThreshold(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 10) / 10;
}

// Pull the 6 optional override fields out of a request body. Returns either
// `{ ok: true, values: {...} }` with each metric's warn/crit (null = use global)
// or `{ ok: false, error }` on bad input or warn >= crit.
function parseThresholdOverrides(body) {
  const out = {};
  for (const key of ['cpu_warn', 'cpu_crit', 'ram_warn', 'ram_crit', 'disk_warn', 'disk_crit']) {
    const v = parseThreshold(body[key]);
    if (v === undefined) return { ok: false, error: `Invalid ${key} (0-100)` };
    out[key] = v;
  }
  for (const m of ['cpu', 'ram', 'disk']) {
    const w = out[`${m}_warn`];
    const c = out[`${m}_crit`];
    if (w != null && c != null && !(w < c)) {
      return { ok: false, error: `${m.toUpperCase()}: warning must be lower than critical` };
    }
  }
  return { ok: true, values: out };
}

// Resolve effective thresholds for a host: per-host override if set, else
// the global default from env vars.
function resolveThresholds(host) {
  return {
    cpu: {
      warning:  host.cpu_warn  != null ? host.cpu_warn  : ALERT_THRESHOLDS.cpu.warning,
      critical: host.cpu_crit  != null ? host.cpu_crit  : ALERT_THRESHOLDS.cpu.critical,
    },
    ram: {
      warning:  host.ram_warn  != null ? host.ram_warn  : ALERT_THRESHOLDS.ram.warning,
      critical: host.ram_crit  != null ? host.ram_crit  : ALERT_THRESHOLDS.ram.critical,
    },
    disk: {
      warning:  host.disk_warn != null ? host.disk_warn : ALERT_THRESHOLDS.disk.warning,
      critical: host.disk_crit != null ? host.disk_crit : ALERT_THRESHOLDS.disk.critical,
    },
  };
}

app.get('/api/config', (_req, res) => {
  res.json({
    demo: DEMO_MODE,
    max_hosts: DEMO_MODE ? DEMO_MAX_HOSTS : null,
    alert_thresholds: ALERT_THRESHOLDS,
    webhook_configured: !!ALERT_WEBHOOK_URL,
    email_configured:   emailEnabled,
  });
});

app.get('/api/hosts', (_req, res) => {
  res.json(db.listHosts());
});

app.post('/api/hosts', (req, res) => {
  const body = req.body || {};
  const target = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!isValidTarget(target)) {
    return res.status(400).json({ error: 'Invalid IP or hostname' });
  }

  const type = ['icmp', 'tcp', 'ssh'].includes(body.check_type) ? body.check_type : 'icmp';

  if (DEMO_MODE) {
    if (type === 'ssh') {
      return res.status(403).json({ error: 'SSH check is disabled in the public demo. Self-host to use SSH mode.' });
    }
    if (db.getAllHosts().length >= DEMO_MAX_HOSTS) {
      return res.status(429).json({ error: `Demo limit reached (${DEMO_MAX_HOSTS} hosts). Delete one to add another.` });
    }
  }

  let parsedPort = parsePort(body.port);
  if (parsedPort === undefined) {
    return res.status(400).json({ error: 'Invalid port (1-65535)' });
  }
  if (type === 'tcp' && !parsedPort) {
    return res.status(400).json({ error: 'Port is required for TCP check' });
  }
  if (type === 'ssh' && !parsedPort) parsedPort = 22;
  if (type === 'icmp') parsedPort = null;

  let user = null;
  let services = null;
  let overrides = { cpu_warn: null, cpu_crit: null, ram_warn: null, ram_crit: null, disk_warn: null, disk_crit: null };
  if (type === 'ssh') {
    const u = typeof body.ssh_user === 'string' ? body.ssh_user.trim() : '';
    if (!isValidSshUser(u)) {
      return res.status(400).json({ error: 'Valid SSH user required (letters, digits, . _ -)' });
    }
    user = u;

    const parsedServices = parseServices(body.services);
    if (!parsedServices.ok) {
      return res.status(400).json({ error: 'Invalid services list (comma-separated unit names, max 20)' });
    }
    services = parsedServices.value;

    const parsedOverrides = parseThresholdOverrides(body);
    if (!parsedOverrides.ok) {
      return res.status(400).json({ error: parsedOverrides.error });
    }
    overrides = parsedOverrides.values;
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;

  // Discovery flag: only meaningful for SSH hosts. Accepts the literal
  // string 'proxmox' for now (extensible to 'docker' / 'libvirt' later).
  let discovery = null;
  if (type === 'ssh' && body.discovery) {
    if (body.discovery !== 'proxmox') {
      return res.status(400).json({ error: 'Unknown discovery type (only "proxmox" supported)' });
    }
    discovery = 'proxmox';
  }

  try {
    const host = db.addHost(target, name, parsedPort, type, user, services, discovery, null);
    if (type === 'ssh' && Object.values(overrides).some((v) => v != null)) {
      db.updateHost(host.id, {
        name, port: parsedPort, ssh_user: user, services,
        ...overrides,
      });
      Object.assign(host, overrides);
    }
    res.status(201).json(host);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Host already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PATCH allows editing a host's mutable fields without changing its identity
// (ip and check_type are intentionally immutable — change those by deleting
// and re-creating). For SSH hosts you can also override the global alert
// thresholds; pass `null` (or omit) on a field to fall back to the env var.
app.patch('/api/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.getHostById(id);
  if (!existing) return res.status(404).json({ error: 'Host not found' });

  const body = req.body || {};

  let name = existing.name;
  if ('name' in body) {
    name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : null;
  }

  let port = existing.port;
  if ('port' in body) {
    const parsed = parsePort(body.port);
    if (parsed === undefined) return res.status(400).json({ error: 'Invalid port (1-65535)' });
    if (existing.check_type === 'tcp' && !parsed) {
      return res.status(400).json({ error: 'Port is required for TCP check' });
    }
    port = existing.check_type === 'icmp' ? null : (parsed || (existing.check_type === 'ssh' ? 22 : null));
  }

  let user = existing.ssh_user;
  let services = existing.services;
  let overrides = {
    cpu_warn:  existing.cpu_warn,  cpu_crit:  existing.cpu_crit,
    ram_warn:  existing.ram_warn,  ram_crit:  existing.ram_crit,
    disk_warn: existing.disk_warn, disk_crit: existing.disk_crit,
  };

  if (existing.check_type === 'ssh') {
    if ('ssh_user' in body) {
      const u = typeof body.ssh_user === 'string' ? body.ssh_user.trim() : '';
      if (!isValidSshUser(u)) {
        return res.status(400).json({ error: 'Valid SSH user required (letters, digits, . _ -)' });
      }
      user = u;
    }
    if ('services' in body) {
      const parsedServices = parseServices(body.services);
      if (!parsedServices.ok) {
        return res.status(400).json({ error: 'Invalid services list (comma-separated unit names, max 20)' });
      }
      services = parsedServices.value;
    }
    // Threshold fields are only honoured if at least one is present in the
    // body — otherwise we leave the stored overrides untouched. Sending all
    // six as empty strings clears the overrides (back to global defaults).
    const hasThresholdField = ['cpu_warn', 'cpu_crit', 'ram_warn', 'ram_crit', 'disk_warn', 'disk_crit']
      .some((k) => k in body);
    if (hasThresholdField) {
      const parsed = parseThresholdOverrides(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      overrides = parsed.values;
    }
  }

  db.updateHost(id, { name, port, ssh_user: user, services, ...overrides });
  res.json({
    id, ip: existing.ip, check_type: existing.check_type,
    name, port, ssh_user: user, services, ...overrides,
  });
});

const WINDOW_SECONDS = {
  '1h':  60 * 60,
  '24h': 24 * 60 * 60,
  '7d':  7  * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

app.get('/api/hosts/:id/history', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const window = WINDOW_SECONDS[req.query.window] ? req.query.window : '1h';
  const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS[window];
  res.json({ window, metrics: db.getMetricsSince(id, since) });
});

app.get('/api/hosts/:id/details', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const host = db.getHostById(id);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  if (host.check_type !== 'ssh') {
    return res.status(400).json({ error: 'Details are only available for SSH hosts' });
  }
  const result = await detailsCheck(host.ip, host.ssh_user, host.port, host.services);
  if (!result.ok) return res.status(502).json({ error: 'SSH host unreachable' });
  res.json({
    services: result.services,
    top_processes: result.top_processes,
    users: result.users,
    network: result.network,
  });
});

// Probe a Proxmox host and return its VMs/CTs without persisting anything.
// The UI lets the user pick which ones to adopt as monitored hosts.
app.get('/api/hosts/:id/discover', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  if (DEMO_MODE) return res.status(403).json({ error: 'Discovery is disabled in the public demo' });
  const host = db.getHostById(id);
  if (!host) return res.status(404).json({ error: 'Host not found' });
  if (host.check_type !== 'ssh' || host.discovery !== 'proxmox') {
    return res.status(400).json({ error: 'Discovery requires a Proxmox SSH host' });
  }
  const result = await discoverProxmox(host.ip, host.ssh_user, host.port);
  if (!result.ok) return res.status(502).json({ error: 'Proxmox host unreachable' });
  res.json({ vms: result.vms });
});

// Adopt a list of discovered VMs as monitored SSH hosts. The shared
// ssh_user is applied to all of them (edit later per host if needed).
// VMs without an IP are skipped — the client should filter those out.
app.post('/api/hosts/:id/adopt', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  if (DEMO_MODE) return res.status(403).json({ error: 'Adoption is disabled in the public demo' });
  const parent = db.getHostById(id);
  if (!parent) return res.status(404).json({ error: 'Parent host not found' });
  if (parent.discovery !== 'proxmox') {
    return res.status(400).json({ error: 'Parent is not a discovery host' });
  }

  const body = req.body || {};
  const sharedUser = typeof body.ssh_user === 'string' ? body.ssh_user.trim() : '';
  if (!isValidSshUser(sharedUser)) {
    return res.status(400).json({ error: 'Valid SSH user required (letters, digits, . _ -)' });
  }
  const vms = Array.isArray(body.vms) ? body.vms : [];
  if (!vms.length) return res.status(400).json({ error: 'No VMs to adopt' });

  const adopted = [];
  const skipped = [];
  for (const v of vms) {
    const ip = typeof v.ip === 'string' ? v.ip.trim() : '';
    if (!isValidTarget(ip)) { skipped.push({ vmid: v.vmid, reason: 'no IP' }); continue; }
    const name = typeof v.name === 'string' && v.name.trim()
      ? v.name.trim()
      : `vm-${v.vmid}`;
    try {
      const host = db.addHost(ip, name, 22, 'ssh', sharedUser, null, null, parent.id);
      adopted.push(host);
    } catch (e) {
      const reason = String(e.message).includes('UNIQUE') ? 'already monitored' : 'db error';
      skipped.push({ vmid: v.vmid, ip, reason });
    }
  }
  res.status(201).json({ adopted, skipped });
});

app.get('/api/alerts', (req, res) => {
  const status = req.query.status === 'recent' ? 'recent' : 'active';
  if (status === 'active') {
    return res.json({ alerts: db.listActiveAlerts() });
  }
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  res.json({ alerts: db.listRecentAlerts(since) });
});

app.delete('/api/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  db.deleteHost(id);
  res.status(204).end();
});

// ICMP check via the system `ping` binary (1 packet, 2 s timeout).
// Uses Promise.race so we always resolve within ~4 s — some sandboxed
// environments (e.g. Render free tier) drop ICMP packets without returning
// an error, which would otherwise leave the check hanging forever.
function icmpCheck(target) {
  const check = new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', target], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null });
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ ok: true, latency: m ? parseFloat(m[1]) : null });
    });
  });
  const fallback = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, latency: null }), 4000);
  });
  return Promise.race([check, fallback]);
}

// TCP connect check — useful when ICMP is blocked (VPNs, firewalls).
function tcpCheck(target, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latency: ok ? Date.now() - start : null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error',   () => finish(false));
    socket.connect(port, target);
  });
}

// Single remote command that prints key=value metrics, newline-separated.
// Simple primitives only — no package installs required on the target host.
const REMOTE_SCRIPT = [
  "top -bn1 | awk '/%Cpu/{print \"cpu=\"$2}'",
  "free | awk '/^Mem:/{printf \"ram=%.1f\\n\", $3/$2*100}'",
  "df / | awk 'END{sub(/%/,\"\",$5); print \"disk=\"$5}'",
  "awk '{printf \"load=%.2f\\n\",$1}' /proc/loadavg",
  "awk '{printf \"uptime=%d\\n\",$1}' /proc/uptime",
].join(';');

function sshCheck(target, user, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [
      '-F', '/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(port || 22),
      `${user}@${target}`,
      REMOTE_SCRIPT,
    ];
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, latency: null, metrics: null });
      const latency = Date.now() - start;
      const parsed = {};
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(\w+)=([\d.]+)/);
        if (m) parsed[m[1]] = parseFloat(m[2]);
      }
      const required = ['cpu', 'ram', 'disk', 'load', 'uptime'];
      for (const k of required) if (!(k in parsed)) {
        return resolve({ ok: true, latency, metrics: null });
      }
      resolve({
        ok: true,
        latency,
        metrics: {
          cpu: parsed.cpu,
          ram: parsed.ram,
          disk: parsed.disk,
          load1: parsed.load,
          uptime_s: Math.round(parsed.uptime),
        },
      });
    });
  });
}

// `who` output varies between distros (Debian 13 prefixes the tty with `sshd`,
// older distros don't, the `from` part may be missing for local logins). This
// parser is permissive: pull the `(from)` from the end of the line if present,
// take the first token as user, and pick the first remaining token that looks
// like a tty (pts/N, ttyN, seat0, console, tmux*) — falling back to the
// second token if nothing matches.
function parseWhoLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let rest = trimmed;
  let from = 'local';
  const fromMatch = rest.match(/\(([^)]+)\)\s*$/);
  if (fromMatch) {
    from = fromMatch[1];
    rest = rest.slice(0, fromMatch.index).trim();
  }
  const tokens = rest.split(/\s+/);
  if (!tokens.length) return null;
  const user = tokens[0];
  const ttyRegex = /^(pts\/\d+|tty\d+|seat\d+|console|tmux\S*)$/;
  const tty = tokens.slice(1).find((t) => ttyRegex.test(t)) || tokens[1] || '';
  // `who` on Debian 13 emits a row per sshd-session (no pty) for every active
  // SSH connection — including the one our probe just opened. Drop those so
  // the panel shows real interactive sessions only.
  if (tty === 'sshd') return null;
  return { user, tty, from };
}

// On-demand details probe: services state + top 5 processes + logged-in
// users + default-iface RX/TX. Service names are validated/sanitised at
// write time, so they are safe to interpolate into the remote shell script.
// The output uses prefixes `svc=`, `proc=`, `usr=`, `net=` so we can parse
// each line unambiguously regardless of order.
function detailsCheck(target, user, port, servicesCsv) {
  const services = (servicesCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && /^[a-zA-Z0-9._@-]+$/.test(s) && s.length <= 64)
    .slice(0, 20);

  // Top 5 processes by CPU. We filter out anything in the same session as our
  // shell ($$) plus any sshd-session helpers, so the table doesn't get
  // dominated by the probe's own ps/awk/bash and the sshd that hosts it.
  const psCmd = "SID=$(ps -o sid= -p $$ | tr -d ' '); ps -eo sid,user,pid,pcpu,pmem,args --sort=-pcpu --no-headers | awk -v s=\"$SID\" '$1 != s && $0 !~ /sshd-session:/ {cmd=\"\"; for(i=6;i<=NF;i++) cmd=cmd\" \"$i; printf \"proc=%s|%s|%s|%s|%s\\n\", $2, $3, $4, $5, substr(cmd,2,80)}' | head -5";

  // Logged-in users (raw `who` lines, prefixed so we can pick them out from
  // mixed stdout). The format of `who` varies between distros — we parse the
  // line in JS rather than trying to be smart in awk.
  const whoCmd = "who 2>/dev/null | sed 's/^/usr=/'";

  // Default-route interface + cumulative RX/TX bytes from /sys/class/net.
  // If there is no default route (or `ip` is missing), this block prints
  // nothing and the network section is omitted in the response.
  const netCmd = "IF=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}'); if [ -n \"$IF\" ]; then RX=$(cat /sys/class/net/\"$IF\"/statistics/rx_bytes 2>/dev/null || echo 0); TX=$(cat /sys/class/net/\"$IF\"/statistics/tx_bytes 2>/dev/null || echo 0); printf 'net=%s|%s|%s\\n' \"$IF\" \"$RX\" \"$TX\"; fi";

  let script = `${psCmd}; ${whoCmd}; ${netCmd}`;
  if (services.length) {
    const svcArgs = services.map((s) => `'${s}'`).join(' ');
    script = `for s in ${svcArgs}; do printf "svc=%s=%s\\n" "$s" "$(systemctl is-active "$s" 2>/dev/null || echo unknown)"; done; ${script}`;
  }

  return new Promise((resolve) => {
    const args = [
      '-F', '/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(port || 22),
      `${user}@${target}`,
      script,
    ];
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      const svcOut = [];
      const procOut = [];
      const userOut = [];
      let network = null;
      for (const line of stdout.split('\n')) {
        const sm = line.match(/^svc=([^=]+)=(.+)$/);
        if (sm) { svcOut.push({ name: sm[1], state: sm[2].trim() }); continue; }
        const pm = line.match(/^proc=([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/);
        if (pm) {
          procOut.push({
            user: pm[1],
            pid: parseInt(pm[2], 10),
            cpu: parseFloat(pm[3]),
            ram: parseFloat(pm[4]),
            command: pm[5].trim(),
          });
          continue;
        }
        const um = line.match(/^usr=(.+)$/);
        if (um) {
          const parsed = parseWhoLine(um[1]);
          if (parsed) userOut.push(parsed);
          continue;
        }
        const nm = line.match(/^net=([^|]+)\|(\d+)\|(\d+)$/);
        if (nm) {
          network = {
            interface: nm[1],
            rx_bytes: parseInt(nm[2], 10),
            tx_bytes: parseInt(nm[3], 10),
          };
        }
      }
      resolve({
        ok: true,
        services: svcOut,
        top_processes: procOut,
        users: userOut,
        network,
      });
    });
  });
}

// Auto-discovery: from a Proxmox host, list all VMs / LXC containers and
// resolve each one's IP without touching the guests. The remote script
// emits prefixed lines so we can parse them in any order:
//   kvm=<vmid>|<status>|<name>      one per KVM VM
//   lxc=<vmid>|<status>|<name>      one per LXC container
//   kvmnet=<vmid>|<mac>             a NIC of a KVM VM (lowercase mac)
//   lxcnet=<vmid>|<mac>|<ip-or->    a NIC of an LXC container (ip optional)
//   neigh=<ip>|<mac>                ARP cache entry on the Proxmox node
const PROXMOX_DISCOVER_SCRIPT = [
  // qm and pct live in /usr/sbin which isn't on a normal user's PATH, and
  // they need root. Detect both: if we're not root, prefix every Proxmox
  // call with `sudo -n` (relies on NOPASSWD being configured for the user,
  // or on the user being root@pam directly).
  'QM=$(command -v qm 2>/dev/null || echo /usr/sbin/qm)',
  'PCT=$(command -v pct 2>/dev/null || echo /usr/sbin/pct)',
  '[ "$(id -u)" -ne 0 ] && SUDO="sudo -n" || SUDO=""',
  // List VMs (KVM)
  '$SUDO $QM list 2>/dev/null | awk \'NR>1 {printf "kvm=%s|%s|%s\\n", $1, $3, $2}\'',
  // List containers (LXC). pct list columns: VMID Status Lock Name
  '$SUDO $PCT list 2>/dev/null | awk \'NR>1 {printf "lxc=%s|%s|%s\\n", $1, $2, $NF}\'',
  // For each KVM/LXC, dump every `netN:` line of its config verbatim and
  // let JS parse the MAC and the optional ip=cidr. Doing the regex in awk
  // tripped up mawk (Debian default) on the {5} quantifier; JS is portable
  // and the data volume is tiny so the round-trip cost is negligible.
  'for v in $($SUDO $QM list 2>/dev/null | awk \'NR>1 {print $1}\'); do ' +
    '$SUDO $QM config $v 2>/dev/null | grep -E \'^net[0-9]+:\' | ' +
    'while IFS= read -r line; do printf "kvmnet=%s|%s\\n" "$v" "$line"; done; ' +
  'done',
  'for v in $($SUDO $PCT list 2>/dev/null | awk \'NR>1 {print $1}\'); do ' +
    '$SUDO $PCT config $v 2>/dev/null | grep -E \'^net[0-9]+:\' | ' +
    'while IFS= read -r line; do printf "lxcnet=%s|%s\\n" "$v" "$line"; done; ' +
  'done',
  // ARP cache (excludes FAILED state to avoid stale entries). `ip` is
  // accessible to non-root users so no sudo is needed here.
  'ip neigh show 2>/dev/null | awk \'{ ' +
    'ip=$1; mac=""; state=$NF; ' +
    'for (i=2;i<=NF;i++) if ($i=="lladdr") { mac=tolower($(i+1)); break } ' +
    'if (mac!="" && state!="FAILED") printf "neigh=%s|%s\\n", ip, mac ' +
  '}\'',
].join('; ');

function discoverProxmox(target, user, port) {
  return new Promise((resolve) => {
    const args = [
      '-F', '/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', String(port || 22),
      `${user}@${target}`,
      PROXMOX_DISCOVER_SCRIPT,
    ];
    execFile('ssh', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      const vms     = new Map();   // vmid -> { vmid, type, name, status, macs:[], ip }
      const arpByMac = new Map();  // mac (lower) -> ip
      const macRe = /[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}/;
      const ipRe  = /(?:^|[ ,])ip=([\d.]+)(?:\/\d+)?/;
      for (const line of stdout.split('\n')) {
        let m;
        if ((m = line.match(/^kvm=(\d+)\|([^|]*)\|(.*)$/))) {
          vms.set(m[1], { vmid: parseInt(m[1], 10), type: 'kvm', status: m[2].trim(), name: m[3].trim(), macs: [], ip: null });
        } else if ((m = line.match(/^lxc=(\d+)\|([^|]*)\|(.*)$/))) {
          vms.set(m[1], { vmid: parseInt(m[1], 10), type: 'lxc', status: m[2].trim(), name: m[3].trim(), macs: [], ip: null });
        } else if ((m = line.match(/^kvmnet=(\d+)\|(.*)$/))) {
          const v = vms.get(m[1]);
          if (v) {
            const mm = m[2].match(macRe);
            if (mm) v.macs.push(mm[0].toLowerCase());
          }
        } else if ((m = line.match(/^lxcnet=(\d+)\|(.*)$/))) {
          const v = vms.get(m[1]);
          if (v) {
            const mm = m[2].match(macRe);
            if (mm) v.macs.push(mm[0].toLowerCase());
            // LXC containers often hard-code their IP in `pct config`, so use
            // it directly without falling back to the ARP cross-reference.
            if (!v.ip) {
              const im = m[2].match(ipRe);
              if (im) v.ip = im[1];
            }
          }
        } else if ((m = line.match(/^neigh=([\d.]+)\|([0-9a-f:]{17})$/))) {
          arpByMac.set(m[2], m[1]);
        }
      }
      // Cross-reference: for any VM still missing an IP, pick the first MAC
      // that appears in the Proxmox node's ARP cache.
      for (const v of vms.values()) {
        if (v.ip) continue;
        for (const mac of v.macs) {
          if (arpByMac.has(mac)) { v.ip = arpByMac.get(mac); break; }
        }
      }
      resolve({ ok: true, vms: Array.from(vms.values()).sort((a, b) => a.vmid - b.vmid) });
    });
  });
}

// In-memory consecutive-failure counter, so we don't fire a DOWN alert on
// a single transient blip. Resets on the first successful check.
const downCounter = new Map();

function classifyMetric(value, thresholds) {
  if (value == null || isNaN(value)) return null;
  if (value >= thresholds.critical) return { level: 'critical', threshold: thresholds.critical };
  if (value >= thresholds.warning)  return { level: 'warning',  threshold: thresholds.warning };
  return null;
}

async function sendWebhook(payload) {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[alerts] webhook failed:', e.message);
  }
}

function metricLabel(metric) {
  if (metric === 'cpu')    return 'CPU';
  if (metric === 'ram')    return 'RAM';
  if (metric === 'disk')   return 'Disk';
  if (metric === 'status') return 'host DOWN';
  return metric;
}

function buildEmailContent(payload) {
  const { event, host, metric, level, value, threshold, timestamp } = payload;
  const hostLabel = host.name || host.ip;
  const metricName = metricLabel(metric);
  const fired = event === 'alert.fired';
  const tag = fired ? `[${level.toUpperCase()}]` : '[CLEARED]';

  let subject;
  if (metric === 'status') {
    subject = fired
      ? `${tag} ${hostLabel} is DOWN`
      : `${tag} ${hostLabel} is back UP`;
  } else if (value != null) {
    subject = fired
      ? `${tag} ${metricName} on ${hostLabel} — ${value.toFixed(1)}%`
      : `${tag} ${metricName} on ${hostLabel} — back to ${value.toFixed(1)}%`;
  } else {
    subject = `${tag} ${metricName} on ${hostLabel}`;
  }

  const valueLine    = value     != null ? `Value:     ${value.toFixed(1)}%\n` : '';
  const thresholdLn  = threshold != null ? `Threshold: ${threshold}%\n`         : '';

  const text =
`${fired ? 'Alert fired' : 'Alert cleared'} on ${hostLabel} (${host.ip})
Metric:    ${metricName}
Level:     ${level}
${valueLine}${thresholdLn}Time:      ${timestamp}

— didactic-dashboard
`;

  const color = fired
    ? (level === 'critical' ? '#dc2626' : '#f59e0b')
    : '#16a34a';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f8fafc;padding:24px;">
  <div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
    <div style="background:${color};color:#fff;padding:14px 20px;font-weight:600;letter-spacing:0.5px;">
      ${fired ? level.toUpperCase() : 'CLEARED'} &middot; ${escapeHtml(metricName)}
    </div>
    <div style="padding:20px;line-height:1.55;">
      <p style="margin:0 0 14px;"><strong>${escapeHtml(hostLabel)}</strong> <span style="color:#64748b;">(${escapeHtml(host.ip)})</span></p>
      <table style="border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#64748b;padding:2px 12px 2px 0;">Metric</td><td>${escapeHtml(metricName)}</td></tr>
        <tr><td style="color:#64748b;padding:2px 12px 2px 0;">Level</td><td>${escapeHtml(level)}</td></tr>
        ${value     != null ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0;">Value</td><td>${value.toFixed(1)}%</td></tr>` : ''}
        ${threshold != null ? `<tr><td style="color:#64748b;padding:2px 12px 2px 0;">Threshold</td><td>${threshold}%</td></tr>` : ''}
        <tr><td style="color:#64748b;padding:2px 12px 2px 0;">Time</td><td>${escapeHtml(timestamp)}</td></tr>
      </table>
      <p style="color:#94a3b8;font-size:12px;margin-top:18px;">— didactic-dashboard</p>
    </div>
  </div>
</body></html>`;

  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendEmail(payload) {
  if (!mailer) return;
  const { subject, text, html } = buildEmailContent(payload);
  try {
    await mailer.sendMail({
      from: ALERT_EMAIL_FROM,
      to:   ALERT_EMAIL_TO,
      subject,
      text,
      html,
    });
  } catch (e) {
    console.warn('[alerts] email failed:', e.message);
  }
}

function alertPayload(event, hostInfo, alert, value) {
  return {
    event,
    alert_id: alert.id,
    host: {
      id:         hostInfo.id,
      ip:         hostInfo.ip,
      name:       hostInfo.name,
      check_type: hostInfo.check_type,
    },
    metric:    alert.metric,
    level:     alert.level,
    value,
    threshold: alert.threshold,
    timestamp: new Date().toISOString(),
  };
}

async function fireAlert(hostInfo, metric, level, value, threshold) {
  const id = db.insertAlert(hostInfo.id, metric, level, value, threshold);
  console.log(`[alerts] FIRED ${level} ${metric} on ${hostInfo.name || hostInfo.ip} (id=${id}, value=${value}, threshold=${threshold})`);
  const payload = alertPayload('alert.fired', hostInfo, { id, metric, level, threshold }, value);
  await Promise.all([sendWebhook(payload), sendEmail(payload)]);
}

async function resolveAlert(alertRow, hostInfo, currentValue) {
  db.clearAlert(alertRow.id);
  console.log(`[alerts] CLEARED ${alertRow.level} ${alertRow.metric} on ${hostInfo.name || hostInfo.ip} (id=${alertRow.id})`);
  const payload = alertPayload('alert.cleared', hostInfo, alertRow, currentValue);
  await Promise.all([sendWebhook(payload), sendEmail(payload)]);
}

async function evaluateAlerts(hostInfo, metrics, isUp) {
  if (isUp) {
    downCounter.delete(hostInfo.id);
    const active = db.getActiveAlert(hostInfo.id, 'status');
    if (active) await resolveAlert(active, hostInfo, null);
  } else {
    const count = (downCounter.get(hostInfo.id) || 0) + 1;
    downCounter.set(hostInfo.id, count);
    if (count >= ALERT_DOWN_AFTER) {
      const active = db.getActiveAlert(hostInfo.id, 'status');
      if (!active) await fireAlert(hostInfo, 'status', 'critical', null, null);
    }
  }
  if (!metrics) return;
  const effective = resolveThresholds(hostInfo);
  for (const metric of ['cpu', 'ram', 'disk']) {
    const value = metrics[metric];
    const thresholds = effective[metric];
    const newClass = classifyMetric(value, thresholds);
    const active = db.getActiveAlert(hostInfo.id, metric);
    if (newClass) {
      if (!active) {
        await fireAlert(hostInfo, metric, newClass.level, value, newClass.threshold);
      } else if (active.level !== newClass.level) {
        // level changed (warning -> critical or vice versa): close old, open new
        await resolveAlert(active, hostInfo, value);
        await fireAlert(hostInfo, metric, newClass.level, value, newClass.threshold);
      }
      // else: same level already firing — stay silent, no webhook spam
    } else if (active) {
      await resolveAlert(active, hostInfo, value);
    }
  }
}

async function checkAll() {
  const hosts = db.getAllHosts();
  await Promise.all(hosts.map(async (h) => {
    let result;
    let metrics = null;
    if (h.check_type === 'ssh') {
      result = await sshCheck(h.ip, h.ssh_user, h.port);
      db.recordPing(h.id, result.ok, result.latency);
      if (result.metrics) {
        db.recordMetrics(h.id, result.metrics);
        metrics = result.metrics;
      }
    } else if (h.check_type === 'tcp' && h.port) {
      result = await tcpCheck(h.ip, h.port);
      db.recordPing(h.id, result.ok, result.latency);
    } else {
      result = await icmpCheck(h.ip);
      db.recordPing(h.id, result.ok, result.latency);
    }
    try {
      await evaluateAlerts(h, metrics, !!result.ok);
    } catch (e) {
      console.warn('[alerts] evaluation failed for host', h.id, e.message);
    }
  }));
}

function seedDemoHosts() {
  if (db.listHosts().length > 0) return;
  for (const d of DEMO_SEEDS) {
    try { db.addHost(d.ip, d.name, d.port, d.check_type, null); } catch {}
  }
  console.log(`demo mode: seeded ${DEMO_SEEDS.length} hosts`);
}

if (DEMO_MODE) seedDemoHosts();

setTimeout(() => {
  checkAll().catch(() => {});
  setInterval(() => checkAll().catch(() => {}), PING_INTERVAL);
}, 2000);

app.listen(PORT, () => {
  const mode = DEMO_MODE ? ' [DEMO]' : '';
  console.log(`didactic-dashboard listening on :${PORT}${mode} (check every ${PING_INTERVAL}ms)`);
  const channels = [];
  if (ALERT_WEBHOOK_URL) channels.push('webhook');
  if (emailEnabled)      channels.push(`email (${SMTP_HOST}:${SMTP_PORT})`);
  console.log(`[alerts] channels: ${channels.length ? channels.join(', ') : 'none (dashboard only)'}`);
});
