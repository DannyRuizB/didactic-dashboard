# didactic-dashboard

### [Try the live demo →](https://didactic-dashboard.onrender.com)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-20-3c873a.svg)
[![Docker Hub](https://img.shields.io/docker/v/dannyruizb/didactic-dashboard?label=docker%20hub&logo=docker&sort=semver)](https://hub.docker.com/r/dannyruizb/didactic-dashboard)
[![Docker Pulls](https://img.shields.io/docker/pulls/dannyruizb/didactic-dashboard?logo=docker)](https://hub.docker.com/r/dannyruizb/didactic-dashboard)
![Image size](https://img.shields.io/docker/image-size/dannyruizb/didactic-dashboard/latest)
![Status](https://img.shields.io/badge/status-WIP-orange.svg)
![Last commit](https://img.shields.io/github/last-commit/DannyRuizB/didactic-dashboard)

Simple self-hosted monitoring dashboard. Add a host by IP and watch its status in real time. Docker-ready, built for learning.

> Work in progress — v0.4.0 released, more features coming.

## Screenshots

Dark theme:

![Dark theme](docs/screenshot-dark.png)

Light theme:

![Light theme](docs/screenshot-light.png)

History charts (click the `chart` button on any SSH host):

![History charts](docs/screenshot-charts.png)

Host details — systemd services + top processes (click the `details` button on any SSH host):

![Host details](docs/screenshot-details.png)

## Live demo

A public demo with pre-seeded hosts (Google, Cloudflare, GitHub, Docker Hub, example.com) is running at **https://didactic-dashboard.onrender.com** — hosted on Render free tier, so the first request after idle may take ~30s to wake up. SSH check mode is disabled on the demo, and only **public** hosts work — LAN IPs (`192.168.x`, `10.x`...) are unreachable from the cloud sandbox. To monitor your own network, self-host with the Quick start above.

## Quick start

### Option A — one-liner from Docker Hub (fastest)

```bash
docker run -d --name didactic-dashboard \
  -p 3000:3000 \
  -v didactic-data:/app/data \
  dannyruizb/didactic-dashboard:latest
```

### Option B — clone and build

```bash
git clone https://github.com/DannyRuizB/didactic-dashboard.git
cd didactic-dashboard
docker compose up -d --build
```

Open http://localhost:3000 and start adding hosts by IP or hostname.

Data persists in the `didactic-data` volume (Option A) or `./data/dashboard.db` (Option B).

## Features

### v0.4.0 (current)
- **Host details panel** (SSH only): click the `details` button on any SSH card to see
  - **systemd services**: live `active` / `inactive` / `failed` state for any units you configured for that host
  - **top 5 processes** by CPU (the probe filters its own session out, so you see real workload)
- Per-host services list configured at add time (comma-separated unit names, e.g. `ssh,cron,nginx`)
- Three check modes per host:
  - **ICMP** — classic ping (default)
  - **TCP** — connect to a given port (works through VPNs / firewalls blocking ICMP)
  - **SSH** — connect, run a small command and collect real-time metrics
- **Metrics** (SSH only): CPU %, RAM %, Disk %, load avg, uptime — with live progress bars
- **History charts**: click any SSH host to see CPU / RAM / disk / load1 over the last `1h`, `24h`, `7d` or `30d`
- Add / remove hosts by IP or hostname from the web UI
- SQLite persistence (hosts, ping history, metrics history)
- One-command Docker Compose deploy
- Warm amber theme with light / dark toggle (persists in localStorage)

### Planned
- v0.4.1 — Host detail panel: connected users + network traffic
- v0.5 — Alerts (warning / critical) via email or webhook
- v0.6 — Auto-discovery on local network

## Why

A lightweight, didactic alternative to Zabbix — simple enough to read, modify and learn from. Great for home labs and small sysadmin practice environments.

## Tech stack

- Node.js + Express (backend)
- SQLite (storage)
- Vanilla HTML / CSS / JS (frontend)
- Docker + Docker Compose (deploy)

## Roadmap

- [x] v0.1 — Add/remove hosts via UI, ICMP + TCP checks, Docker Compose
- [x] v0.2 — SSH-based metrics (CPU, RAM, disk, load, uptime) with live bars
- [x] v0.3 — History charts (1h / 24h / 7d / 30d) per SSH host
- [x] v0.4.0 — Host detail panel: systemd services + top processes
- [ ] v0.4.1 — Host detail panel: connected users + network traffic
- [ ] v0.5 — Alerts (warning / critical) via email or webhook
- [ ] v0.6 — Auto-discovery on local network

## SSH check setup

To use the SSH check mode and collect metrics from remote hosts:

1. Make sure your **SSH key** (`~/.ssh/id_ed25519.pub` or `id_rsa.pub`) is on the target host in its `~/.ssh/authorized_keys`.
2. The container mounts your `~/.ssh` as **read-only** (`~/.ssh:/root/.ssh:ro`), so it reuses your keys without copying them.
3. When adding a host, pick **SSH** as the check type and enter the remote user (e.g. `root`, `ubuntu`, `soltecsis`...). Port defaults to `22`.
4. *(Optional)* In the **services** field, list the systemd unit names you want to monitor for that host, comma-separated (e.g. `ssh,cron,nginx,named`). They show up in the `details` panel with their live state.
5. The target host only needs standard tools (`ps`, `top`, `free`, `df`, `awk`, `/proc`, plus `systemctl` for the services panel) — no agent install required.

The remote user does **not** need root. Standard user privileges are enough for the metrics collected and for `systemctl is-active` queries.

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable        | Default                   | Meaning                          |
|-----------------|---------------------------|----------------------------------|
| `PORT`          | `3000`                    | HTTP port                        |
| `DB_PATH`       | `/app/data/dashboard.db`  | SQLite file path                 |
| `PING_INTERVAL` | `10000`                   | Ping period in ms                |

## License

MIT — see [LICENSE](LICENSE)

## Author

Danny Ruiz — [github.com/DannyRuizB](https://github.com/DannyRuizB)
