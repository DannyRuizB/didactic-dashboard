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
`);

// Migrate older DBs that were created before the `port` column existed.
const cols = db.prepare('PRAGMA table_info(hosts)').all();
if (!cols.some((c) => c.name === 'port')) {
  db.exec('ALTER TABLE hosts ADD COLUMN port INTEGER');
}

const stmts = {
  list: db.prepare(`
    SELECT h.id, h.ip, h.name, h.port, h.created_at,
           p.ts         AS last_ts,
           p.ok         AS last_ok,
           p.latency_ms AS last_latency
    FROM hosts h
    LEFT JOIN (
      SELECT host_id, MAX(ts) AS max_ts FROM pings GROUP BY host_id
    ) latest ON latest.host_id = h.id
    LEFT JOIN pings p ON p.host_id = h.id AND p.ts = latest.max_ts
    ORDER BY h.created_at ASC
  `),
  insertHost: db.prepare('INSERT INTO hosts (ip, name, port) VALUES (?, ?, ?)'),
  deleteHost: db.prepare('DELETE FROM hosts WHERE id = ?'),
  allHosts:   db.prepare('SELECT id, ip, port FROM hosts'),
  insertPing: db.prepare('INSERT INTO pings (host_id, ts, ok, latency_ms) VALUES (?, ?, ?, ?)'),
};

module.exports = {
  listHosts: () => stmts.list.all(),
  addHost: (ip, name, port) => {
    const info = stmts.insertHost.run(ip, name || null, port || null);
    return { id: info.lastInsertRowid, ip, name: name || null, port: port || null };
  },
  deleteHost: (id) => stmts.deleteHost.run(id),
  getAllHosts: () => stmts.allHosts.all(),
  recordPing: (hostId, ok, latencyMs) => {
    stmts.insertPing.run(hostId, Math.floor(Date.now() / 1000), ok ? 1 : 0, latencyMs);
  },
};
