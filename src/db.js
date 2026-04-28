const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dashboard.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT    NOT NULL UNIQUE,
    name       TEXT,
    port       INTEGER,
    check_type TEXT    NOT NULL DEFAULT 'icmp',
    ssh_user   TEXT,
    services   TEXT,
    cpu_warn   REAL,
    cpu_crit   REAL,
    ram_warn   REAL,
    ram_crit   REAL,
    disk_warn  REAL,
    disk_crit  REAL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS pings (
    host_id    INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    ok         INTEGER NOT NULL,
    latency_ms REAL,
    FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pings_host_ts ON pings(host_id, ts);
  CREATE TABLE IF NOT EXISTS metrics (
    host_id  INTEGER NOT NULL,
    ts       INTEGER NOT NULL,
    cpu      REAL,
    ram      REAL,
    disk     REAL,
    load1    REAL,
    uptime_s INTEGER,
    FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_host_ts ON metrics(host_id, ts);
  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id    INTEGER NOT NULL,
    metric     TEXT    NOT NULL,
    level      TEXT    NOT NULL,
    value      REAL,
    threshold  REAL,
    fired_at   INTEGER NOT NULL,
    cleared_at INTEGER,
    FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(host_id, metric) WHERE cleared_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_alerts_fired  ON alerts(fired_at DESC);
`);

// Migrate older databases that predate newer columns.
const cols = db.prepare('PRAGMA table_info(hosts)').all();
const hasCol = (n) => cols.some((c) => c.name === n);
if (!hasCol('port'))       db.exec('ALTER TABLE hosts ADD COLUMN port INTEGER');
if (!hasCol('check_type')) db.exec("ALTER TABLE hosts ADD COLUMN check_type TEXT NOT NULL DEFAULT 'icmp'");
if (!hasCol('ssh_user'))   db.exec('ALTER TABLE hosts ADD COLUMN ssh_user TEXT');
if (!hasCol('services'))   db.exec('ALTER TABLE hosts ADD COLUMN services TEXT');
if (!hasCol('cpu_warn'))   db.exec('ALTER TABLE hosts ADD COLUMN cpu_warn REAL');
if (!hasCol('cpu_crit'))   db.exec('ALTER TABLE hosts ADD COLUMN cpu_crit REAL');
if (!hasCol('ram_warn'))   db.exec('ALTER TABLE hosts ADD COLUMN ram_warn REAL');
if (!hasCol('ram_crit'))   db.exec('ALTER TABLE hosts ADD COLUMN ram_crit REAL');
if (!hasCol('disk_warn'))  db.exec('ALTER TABLE hosts ADD COLUMN disk_warn REAL');
if (!hasCol('disk_crit'))  db.exec('ALTER TABLE hosts ADD COLUMN disk_crit REAL');

// Older rows that had a port but no explicit type should be treated as TCP.
db.exec("UPDATE hosts SET check_type = 'tcp' WHERE port IS NOT NULL AND check_type = 'icmp'");

const stmts = {
  list: db.prepare(`
    SELECT h.id, h.ip, h.name, h.port, h.check_type, h.ssh_user, h.services,
           h.cpu_warn, h.cpu_crit, h.ram_warn, h.ram_crit, h.disk_warn, h.disk_crit,
           h.created_at,
           p.ts         AS last_ts,
           p.ok         AS last_ok,
           p.latency_ms AS last_latency,
           m.cpu        AS cpu,
           m.ram        AS ram,
           m.disk       AS disk,
           m.load1      AS load1,
           m.uptime_s   AS uptime_s
    FROM hosts h
    LEFT JOIN (
      SELECT host_id, MAX(ts) AS max_ts FROM pings GROUP BY host_id
    ) lp ON lp.host_id = h.id
    LEFT JOIN pings p ON p.host_id = h.id AND p.ts = lp.max_ts
    LEFT JOIN (
      SELECT host_id, MAX(ts) AS max_ts FROM metrics GROUP BY host_id
    ) lm ON lm.host_id = h.id
    LEFT JOIN metrics m ON m.host_id = h.id AND m.ts = lm.max_ts
    ORDER BY h.created_at ASC
  `),
  insertHost: db.prepare(`
    INSERT INTO hosts (ip, name, port, check_type, ssh_user, services)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  deleteHost:    db.prepare('DELETE FROM hosts WHERE id = ?'),
  allHosts:      db.prepare(`
    SELECT id, ip, name, port, check_type, ssh_user, services,
           cpu_warn, cpu_crit, ram_warn, ram_crit, disk_warn, disk_crit
    FROM hosts
  `),
  hostById:      db.prepare(`
    SELECT id, ip, name, port, check_type, ssh_user, services,
           cpu_warn, cpu_crit, ram_warn, ram_crit, disk_warn, disk_crit
    FROM hosts WHERE id = ?
  `),
  updateHost: db.prepare(`
    UPDATE hosts SET
      name      = ?,
      port      = ?,
      ssh_user  = ?,
      services  = ?,
      cpu_warn  = ?,
      cpu_crit  = ?,
      ram_warn  = ?,
      ram_crit  = ?,
      disk_warn = ?,
      disk_crit = ?
    WHERE id = ?
  `),
  insertPing:    db.prepare('INSERT INTO pings (host_id, ts, ok, latency_ms) VALUES (?, ?, ?, ?)'),
  insertMetrics: db.prepare(`
    INSERT INTO metrics (host_id, ts, cpu, ram, disk, load1, uptime_s)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  metricsSince: db.prepare(`
    SELECT ts, cpu, ram, disk, load1
    FROM metrics
    WHERE host_id = ? AND ts >= ?
    ORDER BY ts ASC
  `),
  insertAlert: db.prepare(`
    INSERT INTO alerts (host_id, metric, level, value, threshold, fired_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  clearAlert: db.prepare(`
    UPDATE alerts SET cleared_at = ? WHERE id = ?
  `),
  getActiveAlert: db.prepare(`
    SELECT id, host_id, metric, level, value, threshold, fired_at
    FROM alerts
    WHERE host_id = ? AND metric = ? AND cleared_at IS NULL
    ORDER BY fired_at DESC LIMIT 1
  `),
  listActiveAlerts: db.prepare(`
    SELECT a.id, a.host_id, a.metric, a.level, a.value, a.threshold, a.fired_at,
           h.ip, h.name, h.check_type
    FROM alerts a JOIN hosts h ON h.id = a.host_id
    WHERE a.cleared_at IS NULL
    ORDER BY a.fired_at DESC
  `),
  listRecentAlerts: db.prepare(`
    SELECT a.id, a.host_id, a.metric, a.level, a.value, a.threshold, a.fired_at, a.cleared_at,
           h.ip, h.name, h.check_type
    FROM alerts a JOIN hosts h ON h.id = a.host_id
    WHERE a.fired_at >= ?
    ORDER BY a.fired_at DESC
  `),
};

module.exports = {
  listHosts: () => stmts.list.all(),
  addHost: (ip, name, port, checkType, sshUser, services) => {
    const info = stmts.insertHost.run(
      ip,
      name || null,
      port || null,
      checkType,
      sshUser || null,
      services || null,
    );
    return {
      id: info.lastInsertRowid,
      ip,
      name: name || null,
      port: port || null,
      check_type: checkType,
      ssh_user: sshUser || null,
      services: services || null,
      cpu_warn: null, cpu_crit: null,
      ram_warn: null, ram_crit: null,
      disk_warn: null, disk_crit: null,
    };
  },
  updateHost: (id, fields) => {
    stmts.updateHost.run(
      fields.name      ?? null,
      fields.port      ?? null,
      fields.ssh_user  ?? null,
      fields.services  ?? null,
      fields.cpu_warn  ?? null,
      fields.cpu_crit  ?? null,
      fields.ram_warn  ?? null,
      fields.ram_crit  ?? null,
      fields.disk_warn ?? null,
      fields.disk_crit ?? null,
      id,
    );
  },
  deleteHost: (id) => stmts.deleteHost.run(id),
  getAllHosts: () => stmts.allHosts.all(),
  getHostById: (id) => stmts.hostById.get(id),
  recordPing: (hostId, ok, latencyMs) => {
    stmts.insertPing.run(hostId, Math.floor(Date.now() / 1000), ok ? 1 : 0, latencyMs);
  },
  recordMetrics: (hostId, m) => {
    stmts.insertMetrics.run(
      hostId, Math.floor(Date.now() / 1000),
      m.cpu, m.ram, m.disk, m.load1, m.uptime_s,
    );
  },
  getMetricsSince: (hostId, sinceTs) => stmts.metricsSince.all(hostId, sinceTs),
  insertAlert: (hostId, metric, level, value, threshold) => {
    const info = stmts.insertAlert.run(
      hostId, metric, level,
      value == null ? null : value,
      threshold == null ? null : threshold,
      Math.floor(Date.now() / 1000),
    );
    return info.lastInsertRowid;
  },
  clearAlert: (id) => stmts.clearAlert.run(Math.floor(Date.now() / 1000), id),
  getActiveAlert: (hostId, metric) => stmts.getActiveAlert.get(hostId, metric),
  listActiveAlerts: () => stmts.listActiveAlerts.all(),
  listRecentAlerts: (sinceTs) => stmts.listRecentAlerts.all(sinceTs),
};
