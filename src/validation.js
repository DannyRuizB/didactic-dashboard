'use strict';

// Pure validation / parsing / formatting helpers, extracted from server.js so
// they can be unit-tested in isolation (no Express, DB, network or env state).
// server.js requires these instead of defining them inline.

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

// Classify a metric value against {warning, critical} thresholds.
// Returns null when below warning or when the value is missing/NaN.
function classifyMetric(value, thresholds) {
  if (value == null || isNaN(value)) return null;
  if (value >= thresholds.critical) return { level: 'critical', threshold: thresholds.critical };
  if (value >= thresholds.warning)  return { level: 'warning',  threshold: thresholds.warning };
  return null;
}

// `who` output varies between distros; this parser is permissive. Pulls the
// `(from)` from the end if present, takes the first token as user, and picks
// the first remaining token that looks like a tty. Returns null for blank
// lines and for sshd-session rows (no real interactive tty).
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
  if (tty === 'sshd') return null;
  return { user, tty, from };
}

function metricLabel(metric) {
  if (metric === 'cpu')    return 'CPU';
  if (metric === 'ram')    return 'RAM';
  if (metric === 'disk')   return 'Disk';
  if (metric === 'status') return 'host DOWN';
  return metric;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = {
  isValidTarget,
  isValidSshUser,
  parseServices,
  parsePort,
  parseThreshold,
  parseThresholdOverrides,
  classifyMetric,
  parseWhoLine,
  metricLabel,
  escapeHtml,
};
