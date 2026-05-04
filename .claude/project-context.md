# Project Context
_Generated: 2026-05-04_

## Meta
- **Artifact ID**: amnezia-panel
- **Runtime**: Node.js 20 (Alpine)
- **Build tool**: npm, Docker Compose
- **Project type**: Full-stack web panel for managing AmneziaVPN servers (NOT a Spring Boot/Kotlin project)

## Modules
| Module | Purpose |
|--------|---------|
| backend/ | Express.js API server -- SSH into VPS, manage Docker containers for VPN protocols, SQLite DB |
| frontend/ | React SPA -- admin UI for servers, protocols, clients, subscriptions |

## Tech Stack
- **Language**: JavaScript (ES modules)
- **Backend**: Express 4.18, node-ssh 13, sql.js 1.14 (SQLite in-memory persisted to file), jsonwebtoken, bcryptjs, qrcode
- **Frontend**: React 18, Vite 5, React Router 6, Zustand 4, Axios
- **Reverse proxy**: nginx (in frontend container) proxies /api/ to backend:3001 and /sub/ to backend:3001
- **Persistence**: SQLite via sql.js (file at DB_PATH, default /data/panel.db)
- **Deployment**: Docker Compose (two containers: backend + frontend/nginx)

## Directory Structure
```
amnezia-panel/
├── backend/
│   ├── src/
│   │   ├── index.js                — Express app entry point
│   │   ├── middleware/auth.js      — JWT auth middleware + token signing
│   │   ├── routes/
│   │   │   ├── auth.js             — /api/auth (setup, login, status)
│   │   │   ├── servers.js          — /api/servers (CRUD, test SSH, ensure Docker, list containers)
│   │   │   ├── protocols.js        — /api/protocols (install/start/stop/delete, logs, status)
│   │   │   ├── clients.js          — /api/clients (create, QR, config download, config-text)
│   │   │   └── subscriptions.js    — /api/subscriptions + /sub/:slug (public Clash YAML)
│   │   └── services/
│   │       ├── db.js               — SQLite init, schema, query helpers
│   │       ├── ssh.js              — SSH connection pool (node-ssh), exec, execSudo
│   │       ├── protocols.js        — Docker install/configure scripts for AWG2, Xray, WireGuard
│   │       └── subscription.js     — Clash YAML generation, template CRUD, slug-based subscription
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api.js                  — Axios client + all API method wrappers
│   │   ├── App.jsx                 — Routing, layout, global CSS
│   │   ├── main.jsx                — React root
│   │   └── pages/
│   │       ├── DashboardPage.jsx   — Server list, add server modal
│   │       ├── LoginPage.jsx       — Login + setup forms
│   │       ├── SetupPage.jsx       — Re-exports LoginPage
│   │       ├── ServerPage.jsx      — Single server: protocols, clients, QR, config
│   │       └── SubscriptionsPage.jsx — FLClash subscription management, template editor
│   ├── nginx.conf
│   ├── Dockerfile
│   ├── vite.config.js
│   └── package.json
├── docker-compose.yml
├── data/                           — SQLite DB (auto-created)
└── README.md
```

## Entry Points
- `backend/src/index.js` -- Express app on PORT 3001
- `frontend/src/main.jsx` -- React app mounted at #root

## Key Abstractions

### Routes (Express routers)
- `backend/src/routes/auth.js` -- Initial setup (create admin), login, status check. No auth required for setup/login.
- `backend/src/routes/servers.js` -- CRUD for VPS servers, SSH test, Docker install, container listing. JWT-protected.
- `backend/src/routes/protocols.js` -- Install/start/stop/remove VPN protocol containers on VPS. JWT-protected.
- `backend/src/routes/clients.js` -- Create VPN clients, generate configs, QR codes, download .conf files. JWT-protected.
- `backend/src/routes/subscriptions.js` -- Clash YAML subscription CRUD, template editor. Public endpoint at /sub/:slug.

### Services
- `backend/src/services/db.js` -- SQLite via sql.js. Schema: servers, protocols, clients, users, subscriptions, settings tables. Auto-migrates on startup. File-backed at DB_PATH.
- `backend/src/services/ssh.js` -- SSH connection pool using node-ssh. Password or key auth. `exec()` and `execSudo()` helpers. Health-checks cached connections.
- `backend/src/services/protocols.js` -- Core VPN protocol logic. Contains Dockerfiles, start scripts, configure scripts, and client config templates for all three protocols (AWG2, Xray, WireGuard). Reverse-engineered from Amnezia Desktop Client binary.
- `backend/src/services/subscription.js` -- Generates Clash-compatible YAML for FLClash from VLESS URIs. Template-based with placeholder substitution. Slug-based public access.

### Frontend Pages
- `DashboardPage.jsx` -- Lists servers, add server modal
- `ServerPage.jsx` -- Single server view: installed protocols, add protocol modal, client management, QR display, config viewing
- `SubscriptionsPage.jsx` -- Manage FLClash subscriptions, edit Clash template, set VPS host, regenerate all
- `LoginPage.jsx` / `SetupPage.jsx` -- Auth flows

## VPN Protocols (Core Domain)

### AmneziaWG 2.0 (type: `awg2`)
- Docker image: `amneziavpn/amneziawg-go`
- Container name: `amnezia-awg2`
- Obfuscation params: jc, jmin, jmax, s1, s2, s3, s4, h1, h2, h3, h4 (JunkPacket*, MagicHeader*)
- Key files on VPS: `/opt/amnezia/awg/wireguard_server_private_key.key`, `wireguard_server_public_key.key`, `wireguard_psk.key`
- Client config: INI-format .conf with AmneziaWG extensions (Jc, Jmin, Jmax, S1-S4, H1-H4)
- Key generation: `awg genkey`/`awg pubkey`/`awg genpsk` inside container
- Peer addition: `awg set awg0 peer <pubkey>` + append to awg0.conf

### Xray VLESS Reality (type: `xray`)
- Docker image: `alpine:3.15` + Xray core (downloaded from GitHub releases)
- Container name: `amnezia-xray`
- Key params: port (default 443), SNI (default www.googletagmanager.com)
- Key files on VPS: `/opt/amnezia/xray/xray_uuid.key`, `xray_public.key`, `xray_private.key`, `xray_short_id.key`
- Client config: VLESS URI (`vless://uuid@host:port?...`) + Amnezia JSON config (separated by `---AMNEZIA_JSON---` marker in DB)
- Key generation: `xray uuid`, `xray x25519`, `openssl rand -hex 8` inside container
- Client addition: append to server.json clients array, restart container
- Auto-creates FLClash subscription (Clash YAML)

### WireGuard classic (type: `wireguard`)
- Docker image: `alpine:3.15` + wireguard-tools
- Container name: `amnezia-wireguard`
- Key files on VPS: `/opt/amnezia/wireguard/wireguard_server_private_key.key`, `wireguard_server_public_key.key`, `wireguard_psk.key`
- Client config: standard WireGuard .conf (no obfuscation)
- Key generation: `wg genkey`/`wg pubkey`/`wg genpsk` inside container
- Peer addition: `wg set wg0 peer <pubkey>` + append to wg0.conf

## QR Code Generation
- Library: `qrcode` (npm package)
- Endpoint: `GET /api/clients/:id/qr` -- returns `{ qr: "data:image/png;base64,..." }`
- Only uses the primary config part (before `---AMNEZIA_JSON---` separator for Xray clients)
- Size: 300px with margin 2

## Client Creation Flow
1. User provides `protocolId` + `name` to `POST /api/clients`
2. Server looks up protocol and its parent server from DB
3. Based on protocol type, calls `addAWG2Client`/`addXrayClient`/`addWireGuardClient`
4. Each function:
   - Generates client keys inside the Docker container via SSH
   - Adds peer/client to live server config
   - Renders client config from template with variable substitution
5. Config stored in `clients` table (Xray configs have JSON part appended after `---AMNEZIA_JSON---`)
6. For Xray clients, a FLClash subscription is auto-created
7. Frontend can then: display QR (`GET /clients/:id/qr`), show config text, download .conf file

## FLClash Subscriptions
- Only for Xray (VLESS) clients
- Template: Clash YAML with `PROXIES_PLACEHOLDER` and `PROXY_NAME_PLACEHOLDER` markers
- Stored in `settings` table as `clash_template`
- Each subscription gets a unique slug (name-based + random suffix)
- Public URL: `http://<VPS>:8080/sub/<slug>` -- no auth required
- VLESS URI is parsed into Clash proxy format (vless type with reality-opts)
- Template can be edited in UI; all subscriptions can be regenerated from template

## Configuration
- Environment variables:
  - `PORT` (default 3001) -- backend listen port
  - `JWT_SECRET` (default `change-me-in-production`) -- JWT signing secret
  - `DB_PATH` (default `/data/panel.db`) -- SQLite file path
  - `PANEL_PORT` (default 8080) -- external nginx port
- No Spring profiles or application.yml -- all config via env vars
- Frontend dev proxy: Vite proxies `/api` to `http://localhost:3001`

## Database Schema (SQLite)
| Table | Purpose |
|-------|---------|
| servers | VPS hosts with SSH credentials (password or key) |
| protocols | Installed VPN protocol instances per server (type, container_name, port, config JSON, status) |
| clients | VPN clients per protocol (name, config text) |
| users | Admin accounts (username, bcrypt password hash) |
| subscriptions | FLClash Clash YAML subscriptions (slug, vless_url, yaml_content) |
| settings | Key-value store (clash_template, vps_host) |

## API Endpoints Summary
```
Auth:
  GET  /api/auth/status
  POST /api/auth/setup
  POST /api/auth/login

Servers:
  GET    /api/servers
  POST   /api/servers
  DELETE /api/servers/:id
  POST   /api/servers/:id/test
  POST   /api/servers/:id/ensure-docker
  GET    /api/servers/:id/containers

Protocols:
  GET    /api/protocols
  GET    /api/protocols/server/:serverId
  POST   /api/protocols/server/:serverId
  DELETE /api/protocols/:id
  POST   /api/protocols/:id/start
  POST   /api/protocols/:id/stop
  GET    /api/protocols/:id/status
  GET    /api/protocols/:id/logs

Clients:
  GET    /api/clients/protocol/:protocolId
  POST   /api/clients
  DELETE /api/clients/:id
  GET    /api/clients/:id/qr
  GET    /api/clients/:id/config-text
  GET    /api/clients/:id/config          (download .conf)
  GET    /api/clients/:id/config-amnezia  (download Amnezia JSON for Xray)
  GET    /api/clients/:id/subscription

Subscriptions:
  GET    /api/subscriptions
  DELETE /api/subscriptions/:id
  GET    /api/subscriptions/template
  POST   /api/subscriptions/template
  POST   /api/subscriptions/template/reset
  POST   /api/subscriptions/regenerate
  GET    /api/subscriptions/settings
  POST   /api/subscriptions/settings

Public:
  GET    /sub/:slug  (Clash YAML for FLClash)
```

## External Dependencies (key only)
| Dependency | Version | Purpose |
|------------|---------|---------|
| express | 4.18 | HTTP server |
| node-ssh | 13.2 | SSH into VPS servers |
| sql.js | 1.14 | SQLite (compiled to WASM) |
| jsonwebtoken | 9.0 | JWT auth |
| bcryptjs | 2.4 | Password hashing |
| qrcode | 1.5 | QR code generation |
| uuid | 9.0 | Primary key generation |
| react | 18.2 | Frontend UI |
| axios | 1.6 | HTTP client (frontend) |
| zustand | 4.5 | State management (frontend) |

## Architecture Notes
- This is NOT a Spring Boot/Kotlin project. It is a Node.js + React application.
- The backend operates as an SSH orchestration layer: it connects to remote VPS servers via SSH and runs Docker commands to install and manage VPN containers.
- All VPN protocol logic (Dockerfiles, start scripts, configure scripts, client config templates) was reverse-engineered from the Amnezia Desktop Client binary.
- The SSH service maintains a connection pool (Map of serverId -> NodeSSH instance) with automatic reconnection.
- Remote file writes use base64 encoding to avoid shell escaping issues.
- Client configs for Xray are stored with a dual format: VLESS URI + Amnezia JSON, separated by `---AMNEZIA_JSON---` marker in the same DB field.
- SQLite DB is loaded into memory (sql.js/WASM) and persisted to disk on every write. This is not suitable for high-concurrency.
- The frontend is a single-page app served by nginx, which also reverse-proxies API requests to the backend container.
- Docker Compose is the only deployment mechanism. Backend port (3001) is NOT exposed externally; all traffic goes through nginx on the frontend container.
- No automated tests exist in the project.
- The `@sqlitecloud/drivers` package is listed as a dependency but the code uses `sql.js` exclusively -- likely an unused/remnant dependency.

## Known External Services
- VPS servers managed via SSH (user-provided hosts)
- Docker Hub images: `amneziavpn/amneziawg-go`, `alpine:3.15`
- Xray GitHub releases: `https://github.com/XTLS/Xray-core/releases/download/`
- Docker install script: `https://get.docker.com`
