# Project Context — amneziavpn-web-panel
_Generated: 2026-08-03_
_Git commit: 1bf57c3_
_Scan: .claude/agents/project-scanner_

## Overview
Web-панель управления AmneziaVPN. Backend по SSH ходит на удалённые VPS и
управляет Docker-контейнерами VPN-протоколов (по контейнеру на протокол):
собирает образы, пишет конфиги, выпускает клиентов. Состояние (серверы,
протоколы, клиенты, снимки статистики, подписки, пользователи) — в локальной
sqlite (better-sqlite3, WAL). Frontend — React SPA, nginx отдаёт статику и
проксирует `/api` и `/sub/<slug>` к backend.

## Packages
| Dir | Stack | Role |
|---|---|---|
| `backend/` | Node 20 + TS (ESM, `tsx`), Express 4, better-sqlite3, node-ssh, zod, pino, vitest | API; SSH→VPS; сборка/запуск Docker-контейнеров протоколов; sqlite |
| `frontend/` | React 18 + Vite 5 + TS, react-router-dom 6, axios, dnd-kit | SPA-панель |
| `data/` | — | `panel.db` (sqlite), монтируется в backend как `/data` |

`server_scripts/` **удалён** (коммит a7f2fb0) — ничем не использовался.

## Backend
### Stack & entry
- Run: `tsx src/index.ts`; entry `backend/src/index.ts`.
- Scripts: `npm start`, `npm run typecheck`, `npm test` (vitest run), `npm run test:watch`.
- Middleware (в порядке): `express-async-errors` → `validateEnv()` → helmet
  (CSP `default-src 'none'`, HSTS в prod) → cookie-parser → `express.json({limit:'2mb'})`
  → `csrfMiddleware` на `/api` → per-route `authMiddleware` (JWT в httpOnly-cookie)
  → zod `validateBody` (`middleware/validate.ts`).
- Инициализация: `initEncryption()` и `await getDb()` до монтирования роутов;
  фейл любого — `process.exit(1)`.
- Error handling: глобальный `errorHandler` (`index.ts:91`). **UserError**
  (`services/errors.ts`) отдаётся клиенту как есть со своим статусом (логируется
  `warn`); всё остальное логируется целиком (`'Unhandled error'`) и отдаётся как
  обезличенное `{ error: 'Internal server error' }`. Хендлеры try/catch не используют.
- `uncaughtException` / `unhandledRejection` логируются, но процесс не убивают.
- Background: `statsWorker` (per-client трафик), graceful shutdown по SIGTERM/SIGINT
  (`stopStatsWorker` → `flushSave` (WAL checkpoint) → `disconnectAll` SSH, таймаут 10 с).
- `GET /api/health` — без auth и CSRF (docker healthcheck).

### Routes (mounted под /api; subscriptions дополнительно с `/`)
| Mount | File | Endpoints (47 всего) |
|---|---|---|
| /api/auth | routes/auth.ts | 5: `POST /setup`, `GET /status`, `POST /login` (rate-limit), `POST /logout`, `GET /me` |
| /api/servers | routes/servers.ts | 13: CRUD (`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`), `POST /:id/test`, `POST /:id/ensure-docker`, `GET/POST/DELETE /:id/dns`, `GET /:id/containers`, `POST /:id/scan-protocols`, `POST /:id/import-protocol` |
| /api/protocols | routes/protocols.ts | 11: `GET /` (каталог PROTOCOLS), `GET /server/:serverId`, **`GET /server/:serverId/health` → `{ statuses, drift }`**, `POST /server/:serverId` (install), `DELETE /:id`, `POST /:id/start|stop`, `GET /:id/status`, `GET /:id/stats-status`, `POST /:id/enable-stats`, `GET /:id/logs` |
| /api/clients | routes/clients.ts | 9: `POST /`, `GET /protocol/:protocolId`, `GET /:id/config`, `/config-amnezia`, `/config-text`, `/qr`, `/subscription`, `/stats?range=`, `DELETE /:id` (с отзывом peer'а на сервере) |
| /api/subscriptions + `/` | routes/subscriptions.ts | 9: публичный `GET /sub/:slug` (rate-limit), `GET /`, `DELETE /:id`, `GET/POST /template`, `POST /template/reset`, `POST /regenerate`, `GET/POST /settings` |

`POST /protocols/server/:serverId` возвращает строку протокола целиком (как
`GET /server/:serverId`) — фронт кладёт ответ прямо в список.

### Services (`backend/src/services/`)
- `db.ts` — better-sqlite3, `DB_PATH` (по умолчанию `../../data/panel.db`),
  `journal_mode=WAL`, `synchronous=NORMAL`; `query/queryOne/run`, миграции и
  бэкфилл (`clients.peer_id`), шифрование секретов при записи. `save()` — no-op,
  `flushSave()` делает `wal_checkpoint(TRUNCATE)`.
- `errors.ts` — `UserError` (сообщение предназначено пользователю) + `isUserError`.
- `crypto.ts` — AES-256-GCM, ключ `PANEL_ENCRYPTION_KEY`; `encrypt/decrypt/isEncrypted`.
- `env.ts` — валидация окружения при старте (отказ на слабых `JWT_SECRET`).
- `ssh.ts` — node-ssh, пул соединений; `exec` / `execSudo` / `disconnectAll`.
- `shell.ts` — валидаторы ввода в shell: `assertContainerName`, `assertPort`,
  `assertDomain`, `assertWgKey`, `assertMagicHeader`, `assertUint32Range`,
  `assertXrayPath`, `assertXhttpMode`, `sh`, `shInt`. Бросают `UserError`.
- `logger.ts` — pino (pino-pretty вне prod).
- `peerId.ts` — извлечение peer_id из stored config (pubkey / UUID / secret).
- `amneziaExport.ts` — Amnezia-формат: JSON, `vpn://` URI, chunked QR (qCompress).
- `subscription.ts` — Clash YAML подписки (шаблон в `settings.clash_template`), slug'и.
- `statsWorker.ts` — периодический опрос протоколов (одно SSH-соединение на сервер),
  пишет накопительные снимки в `client_stats`.
- `statsAggregate.ts` — чистые функции над снимками: `sumTraffic` (сумма
  положительных приращений, не последний снимок), `downsample`, `rateSeries`.

### Protocols (`backend/src/services/protocols/`)
Диспетчер — barrel `index.ts`. `ProtocolType = 'awg2' | 'wireguard' | 'xray' | 'telemt'`
(**MTProxy удалён полностью** — нет ни типа, ни `mtproxy.ts`).

| Protocol | File | install / addClient notes |
|---|---|---|
| awg2 (AmneziaWG) | awg2.ts | userspace amneziawg-go. Обфускация: Jc/Jmin/Jmax, S1-S4 (>=12), H1-H4 (диапазоны "min-max"), I1-I5. **AWG 3.0**: `HeaderProtectionKey` (server-side, генерится в контейнере) + client-side `contentPaddingAddition`, `rekeyAfterTime/Timeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts`; `config.protocolVersion` = `'3'` при header protection, иначе `'2'`. Механика — через `wgCommon`. |
| wireguard | wireguard.ts | kernel-модуль `wireguard` (alpine + wireguard-tools); свой `start.sh` в `/opt/amnezia/wireguard/`. Механика — через `wgCommon`. |
| xray | xray.ts | VLESS + Reality; транспорт `tcp` (flow xtls-rprx-vision) или `xhttp` (SplitHTTP, без flow); addClient правит server.json в контейнере + restart; stats через StatsService API. |
| telemt | telemt.ts | Telegram MTProto-прокси с FakeTLS; клиент = отдельный secret → `tg://proxy`. |
| — | wgCommon.ts | **общая механика WG/AWG**: `WgFlavor` (tool/iface/confDir/container/image/buildDir), `wgRunArgs`, `installWgLike`, `genPeerKeys`, `nextClientIp`, `addPeer`, `removePeer`, `assertContainerRunning`. |
| — | common.ts | `prepareHost` (ip_forward + сеть `amnezia-dns-net`), `assertPortFree`, `buildImage` (по sha Dockerfile), `runContainer` + `RUN_ARGS_LABEL`/`runArgsSha`, `writeRemoteFile`/`readRemoteFile`/`readContainerFile` (base64), `renderTemplate`, `removePeerBlock`, rand*. |
| — | containers.ts | статусы контейнеров (`getContainersHealth` — один SSH-вызов), start/stop/remove/logs, `listAmneziaContainers`, `ensureDocker`, `scanExistingProtocols`, каталог `PROTOCOLS`. |
| — | dockerfiles.ts | JS template literals: Dockerfile'ы + start/configure-скрипты + шаблоны клиентских конфигов (следить за экранированием). |
| — | stats.ts | чтение per-peer трафика: `readAwgWgPeerStats`, `readXrayPeerStats`, `readTelemtPeerStats`, `isXrayStatsEnabled`, `enableXrayStats`. |
| — | dns.ts | AmneziaDNS (unbound, DoT наружу), фиксированный IP `172.29.172.254`. |
| — | drift.ts | **новое**: сравнивает метки образа (`panel.dockerfile-sha`) и контейнера (`panel.run-sha`) с тем, что панель поставила бы сейчас; отдаёт `{ image, runArgs }` на протокол. Один SSH-вызов на все контейнеры; падение не роняет health. |

### Pinned images (как ЗАДУМАНО, не как развёрнуто)
| Протокол | FROM в dockerfiles.ts | Тег собираемого образа |
|---|---|---|
| awg2 | `amneziavpn/amneziawg-go:3.0.3` | `amnezia-awg2:3.0.3` |
| wireguard | `alpine:3.15` (+ wireguard-tools из apk) | `amnezia-wireguard:latest` |
| xray | `alpine:3.15`, `ARG XRAY_RELEASE="v25.8.3"` | `amnezia-xray:latest` |
| telemt | `debian:12-slim`, бинарь с GitHub **`releases/latest`** | `amnezia-telemt:latest` |
| dns | `mvance/unbound:1.22.0` | `amnezia-dns:latest` |

_Пометки про `:latest`:_ локальные теги `amnezia-*:latest` — наши собственные,
дрейфа апстрима не несут (образ пересобирается при смене sha Dockerfile).
Реальный риск молчаливого дрейфа — **telemt**: бинарь тянется с
`releases/latest`, версия не прибита. Базы awg2/xray/dns/alpine прибиты
намеренно: `amneziavpn/amneziawg-go:latest` однажды уехал с 0.2.19 на 3.0.3 и
сменил мажорную версию демона под живыми клиентами. При бампе версии awg2
менять и `FROM`, и `imageName` (`awg2.ts`, `drift.ts`).
Что реально крутится на сервере — вопрос рантайма, его решает `drift.ts`, не этот файл.

### Data
- DB: sqlite через better-sqlite3, `DB_PATH=/data/panel.db` (в контейнере), WAL.
- Таблицы: `servers`, `protocols`, `clients` (+ `peer_id`), `client_stats`
  (PK `(client_id, ts)`, индекс по `ts`), `users`, `subscriptions`, `settings`.
  Внешние ключи с `ON DELETE CASCADE`.
- Секреты (SSH-пароли/ключи) шифруются `PANEL_ENCRYPTION_KEY` в `services/crypto.ts`.

### Тесты
vitest, файлы `*.test.ts` рядом с модулями: `shell.test.ts`, `peerId.test.ts`,
`amneziaExport.test.ts`, `statsAggregate.test.ts`, `db.test.ts`,
`protocols/common.test.ts`, `protocols/awg2.test.ts`. Покрывают чистые функции
(валидаторы, рендер шаблонов, агрегация, run-args) — там и случались баги.

## Frontend
- Build: Vite (`vite --port 3000` dev с proxy `/api` и `/sub` на :3001, `vite build`).
- Entry `src/main.tsx` → `src/App.tsx`.
- Routes (react-router-dom): `/setup` → SetupPage, `/login` → LoginPage,
  `/` и `/servers` → DashboardPage, `/server/:id` → ServerPage,
  `/subscriptions` → SubscriptionsPage. Приватные — через `PrivateLayout`.
- API client: `src/api.ts` — axios `baseURL: '/api'`, `withCredentials`,
  double-submit CSRF (cookie `panel_csrf` → заголовок `X-CSRF-Token` на не-GET),
  редирект на `/login` при 401. Группы: `authApi`, `serversApi`, `protocolsApi`,
  `clientsApi`, `subscriptionsApi`. Типы `ServerRecord`, `ProtocolRecord`,
  `ClientRecord`, `ProtocolDrift`, `HealthResponse { statuses, drift }`.
- `src/protocols.ts` — **новое**: единственный источник отображаемых названий и
  иконок (`PROTOCOL_ICONS`, `PROTOCOL_NAMES`, `protocolTitle`). Заголовок карточки
  выводится из `type + config` (awg2 → «AmneziaWG 3.0» / «2.0» по `protocolVersion`),
  а НЕ из `protocols.name` в БД — та колонка больше не пишется при установке.
- Pages: `LoginPage`, `SetupPage`, `AuthForm`, `DashboardPage`, `ServerPage`,
  `SubscriptionsPage`.
- `pages/server/`: ProtocolCard, InstallProtocolModal, AddClientModal, ClientModal,
  EditServerModal, ScanProtocolsModal, StatsModal, StatsTab, Sparkline,
  CopySubButton + утилиты `clipboard.ts`, `format.ts`.

## Deploy / Env
- docker-compose: `backend` (build `./backend`, `PORT=3001`, volume `./data:/data`,
  healthcheck `wget /api/health`, только во внутренней сети `panel`), `frontend`
  (build `./frontend`, `${PANEL_PORT:-80}:80`, `depends_on: backend healthy`).
- Env: `JWT_SECRET`, `PANEL_ENCRYPTION_KEY`, `DB_PATH=/data/panel.db`, `PANEL_PORT`.
- **Исходник НЕ bind-mounted** → деплой правок: `docker compose up -d --build <svc>`.
- **Рабочий каталог запущен на боевом VPS** — рядом крутятся прод-контейнеры
  (`amnezia-panel-backend/frontend`, `amnezia-xray`, `amnezia-wireguard`, …).

## Architecture Notes
- **Auth:** первичная настройка через `/setup`; логин выдаёт JWT в httpOnly-cookie,
  CSRF double-submit на `/api` (GET пропускается). Скачивание конфигов
  (`/clients/:id/config*`) авторизуется тем же cookie через `verifyAuth`.
- **Управление протоколом:** панель по SSH делает `prepareHost` (ip_forward +
  сеть `amnezia-dns-net`), проверяет свободность порта, собирает Docker-образ
  (`buildImage`, skip если sha Dockerfile совпал), пишет start/configure-скрипты
  через base64, запускает контейнер с меткой `panel.run-sha` и конфигурирует через
  `docker exec`. Клиенты добавляются правкой конфига внутри контейнера
  (`wg/awg set` + дозапись `[Peer]`, правка `server.json` у Xray, secret у telemt);
  удаление клиента отзывает peer на сервере и удаляет подписку.
- **Drift:** health-запрос попутно сверяет метки образа/контейнера с текущим кодом
  и показывает расхождение в UI — сигнал «переустанови протокол», не ошибка.
- **Экспорт клиента:** оригинальный `.conf` / VLESS-URI / `tg://proxy` + Amnezia
  `vpn://` и chunked QR (`amneziaExport.ts`); подписки Clash YAML на `/sub/<slug>`.
- **Статистика:** `statsWorker` снимает накопительные счётчики per-peer в
  `client_stats`; отображаемый трафик за период считается `statsAggregate.ts` как
  сумма положительных приращений между снимками (контейнер при рестарте обнуляет счётчики).
- **AmneziaDNS:** серверный unbound-резолвер (DoT наружу), фиксированный IP
  `172.29.172.254`; WG/AWG-клиенты автоматически получают его в `DNS =`.
