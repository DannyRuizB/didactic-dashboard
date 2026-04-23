# didactic-dashboard

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-20-3c873a.svg)
[![Docker Hub](https://img.shields.io/docker/v/dannyruizb/didactic-dashboard?label=docker%20hub&logo=docker&sort=semver)](https://hub.docker.com/r/dannyruizb/didactic-dashboard)
[![Docker Pulls](https://img.shields.io/docker/pulls/dannyruizb/didactic-dashboard?logo=docker)](https://hub.docker.com/r/dannyruizb/didactic-dashboard)
![Image size](https://img.shields.io/docker/image-size/dannyruizb/didactic-dashboard/latest)
![Status](https://img.shields.io/badge/status-WIP-orange.svg)
![Last commit](https://img.shields.io/github/last-commit/DannyRuizB/didactic-dashboard)

Simple self-hosted monitoring dashboard. Add a host by IP and watch its status in real time. Docker-ready, built for learning.

> Work in progress — v0.1 released, more features coming.

## Screenshots

Dark theme:

![Dark theme](docs/screenshot-dark.png)

Light theme:

![Light theme](docs/screenshot-light.png)

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

### v0.1 (current)
- Add hosts by IP or hostname from the web UI
- Live status (up / down) — **ICMP ping** by default, or **TCP connect** to a chosen port
- Measured latency in ms
- SQLite persistence (hosts + ping history)
- One-command Docker Compose deploy
- Warm amber theme with light / dark toggle (persists in localStorage)

### Why two check modes?
Some networks (VPNs, cloud firewalls) drop ICMP but allow TCP. Adding a
port (e.g. `22` for SSH, `80` for HTTP) switches the host to a TCP
connect check, which works through those restrictions.

### Planned
- SSH-based metrics: CPU, RAM, disk, load, uptime
- Service status (systemd)
- Top processes and active connections
- Historical charts (1h / 24h / 7d / 30d)
- Alerts (warning / critical)
- Auto-discovery on local network

## Why

A lightweight, didactic alternative to Zabbix — simple enough to read, modify and learn from. Great for home labs and small sysadmin practice environments.

## Tech stack

- Node.js + Express (backend)
- SQLite (storage)
- Vanilla HTML / CSS / JS (frontend)
- Docker + Docker Compose (deploy)

## Roadmap

- [x] v0.1 — Add/remove hosts via UI, ICMP + TCP checks, Docker Compose
- [ ] v0.2 — SSH-based detailed metrics (CPU, RAM, disk, services)
- [ ] v0.3 — History charts and alerts
- [ ] v0.4 — Auto-discovery on local network

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
