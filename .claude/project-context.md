# Project Context — amneziavpn-web-panel
_Generated: 2026-06-10_
_Git commit: 3505dec_
_Scan: .claude/agents/project-scanner_

## Overview
Web-панель управления AmneziaVPN. Backend по SSH подключается к удалённым VPS и
управляет Docker-контейнерами VPN-протоколов (по контейнеру на протокол).
Состояние (серверы, протоколы, клиенты, статистика, подписки, пользователи) —
в локальной sqlite. Frontend — React SPA, проксируется nginx'ом к backend.

## Packages
| Dir | Stack | Role |
|---|---|---|
| `backend/` | Node 20 + TS (ESM, `tsx`), Express 4 | API; SSH→VPS; сборка/запуск Docker-контейнеров протоколов; sqlite |
| `frontend/` | React 18 + Vite + TS, react-router-dom, axios, dnd-kit | SPA-панель |

## Backend
### Stack & entry
- Run: `tsx src/index.ts`; entry `backend/src/index.ts`.
- Middleware: helmet (строгий CSP), cookie-parser, `express.json({limit:'2mb'})`,
  CSRF (`/api`), auth (JWT в httpOnly-cookie, `middleware/auth.ts`), zod-валидация
  (`middleware/validate.ts`).
- Error handling: глобальный `errorHandler` (`index.ts:90`) логирует полный `err`
  через pino, клиенту отдаёт обезличенное `{ error: 'Internal server error' }`.
  Маршруты обычно НЕ оборачивают хендлеры в try/catch (есть `express-async-errors`).
- Фоновое: `statsWorker` (сбор per-client трафика), graceful shutdown.

### Routes (под `/api`, + subscriptions с `/`)
| Mount | File | ~Endpoints |
|---|---|---|
| /api/auth | routes/auth.ts | 5 — setup/login/logout/верификация |
| /api/servers | routes/servers.ts | 9 — CRUD серверов, проверка SSH |
| /api/protocols | routes/protocols.ts | 11 — install/scan/start-stop/удаление протоколов |
| /api/clients | routes/clients.ts | 9 — создание клиента, config/qr/config-text, stats, удаление |
| /api/subscriptions, / | routes/subscriptions.ts | 9 — выдача подписок по slug |

### Services (`backend/src/services/`)
- `db.ts` — sqlite (better-sqlite3); таблицы: `servers`, `protocols`, `clients`,
  `client_stats`, `users`, `subscriptions`, `settings`. Делает миграции/бэкфилл.
- `crypto.ts` — шифрование секретов (`PANEL_ENCRYPTION_KEY`).
- `ssh.ts` — node-ssh: `exec` / `execSudo` на удалённом сервере.
- `shell.ts` — валидация ввода в shell-команды: `assertContainerName`,
  `assertPort`, `assertDomain`, `shInt`. **Использовать для любого ввода в SSH/Docker.**
- `logger.ts` — pino. `env.ts` — конфиг окружения.
- `peerId.ts` — извлечение peer_id из stored config (pubkey/UUID/secret).
- `amneziaExport.ts` — сборка Amnezia-формата: JSON, `vpn://` URI, chunked QR
  (qCompress = 4 байта BE длины + zlib).
- `subscription.ts` — slug-подписки. `statsWorker.ts` — периодический сбор статистики.

### Protocols (`backend/src/services/protocols/`)
Диспетчер — `index.ts`. По файлу на протокол, каждый экспортит `install*` и `add*Client`:
| Protocol | File | Notes |
|---|---|---|
| AWG2 | awg2.ts | AmneziaWG (userspace amneziawg-go, без kernel-модуля) |
| WireGuard | wireguard.ts | kernel-модуль `wireguard` (alpine+wireguard-tools); install перезапускает контейнер после configure, чтобы `start.sh` поднял wg0 |
| Xray | xray.ts | VLESS+Reality; addClient правит server.json внутри контейнера и `docker restart` |
| MTProxy | mtproxy.ts | Telegram MTProto-прокси |
| Telemt | telemt.ts | сторонний MTProto с FakeTLS; per-client stats |
| common.ts | — | `buildImage` (skip если образ есть), `writeRemoteFile`/`readRemoteFile`/`readContainerFile` (base64), `renderTemplate`, rand* |
| containers.ts | — | скан существующих контейнеров/клиентов на сервере |
| dockerfiles.ts | — | JS-шаблоны Dockerfile + start/configure-скриптов (следить за экранированием!) |
| stats.ts | — | чтение per-peer трафика (awg/wg/xray/telemt) |

## Frontend
- Build: Vite (`vite --port 3000` dev, `vite build`); entry `src/main.tsx` → `src/App.tsx`.
- Routes (react-router-dom): `/setup`, `/login`, `/` и `/servers` → DashboardPage,
  `/server/:id` → ServerPage, `/subscriptions` → SubscriptionsPage. Приватные —
  через `PrivateLayout`.
- API client: `src/api.ts` (axios к backend, auth по cookie).
- Pages: `pages/{LoginPage,SetupPage,DashboardPage,ServerPage,SubscriptionsPage}.tsx`,
  `pages/AuthForm.tsx`.
- ServerPage-компоненты (`pages/server/`): ProtocolCard, InstallProtocolModal,
  AddClientModal, ClientModal, EditServerModal, ScanProtocolsModal, StatsModal,
  StatsTab, Sparkline, CopySubButton + утилиты `clipboard.ts`, `format.ts`.

## Deploy / Env
- docker-compose сервисы: `backend` (:3001, build `./backend`, volume `./data:/data`,
  healthcheck `/api/health`), `frontend` (build `./frontend`, `${PANEL_PORT:-80}:80`,
  отдаёт SPA + проксирует `/api`, подписки на `/sub/<slug>`).
- Env: `JWT_SECRET`, `PANEL_ENCRYPTION_KEY`, `DB_PATH=/data/panel.db`, `PANEL_PORT`.
- **Исходник НЕ bind-mounted** → деплой правок: `docker compose up -d --build <svc>`.
- **Рабочий каталог запущен на боевом VPS** — присутствуют прод-контейнеры
  (`amnezia-panel-backend/frontend`, `amnezia-xray`, `amnezia-wireguard`, …).

## Architecture Notes
- Auth: JWT в httpOnly-cookie; первичная настройка через `/setup`; CSRF на `/api`.
- Поток управления протоколом: панель по SSH собирает Docker-образ на VPS
  (`buildImage`), пишет start/configure-скрипты, запускает контейнер, конфигурирует
  через `docker exec`. Клиенты добавляются либо правкой конфига в контейнере
  (xray/wg/awg2: `wg set` + дозапись в `*.conf`), либо в файлы протокола.
- Экспорт клиента: оригинальный `.conf`/VLESS-URI + Amnezia `vpn://`/QR
  (`amneziaExport.ts`). Stats: `statsWorker` периодически снимает per-peer трафик.
