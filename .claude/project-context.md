# Project Context — amneziavpn-web-panel
_Generated: 2026-08-14_
_Git commit: b2e79f7_
_Scan: .claude/agents/project-scanner_

## Overview
Web-панель управления AmneziaVPN. Backend по SSH ходит на удалённые VPS и
управляет Docker-контейнерами VPN-протоколов (по контейнеру на протокол):
собирает образы, пишет конфиги, выпускает клиентов, снимает статистику, чистит
диск. Состояние (серверы, протоколы, клиенты, снимки трафика, подписки,
пользователи, журнал действий) — в локальной sqlite (better-sqlite3, WAL).
Frontend — React SPA; nginx отдаёт статику и проксирует `/api` и `/sub/<slug>`
к backend.

## Packages
| Dir | Stack | Role |
|---|---|---|
| `backend/` | Node 20 + TS (ESM, `tsx`), Express 4, better-sqlite3, node-ssh, zod, pino, bcryptjs, jsonwebtoken, qrcode, express-rate-limit, helmet, vitest | API; SSH→VPS; сборка/запуск Docker-контейнеров протоколов; sqlite |
| `frontend/` | React 18 + Vite 5 + TS, react-router-dom 6, axios, dnd-kit | SPA-панель |
| `data/` | — | `panel.db` (sqlite), монтируется в backend как `/data` |

`server_scripts/` удалён (коммит a7f2fb0) — ничем не использовался.

## Backend
### Stack & entry
- Run: `tsx src/index.ts`; entry `backend/src/index.ts`.
- Scripts: `npm start`, `npm run typecheck`, `npm test` (vitest run), `npm run test:watch`.
- Middleware (в порядке): `express-async-errors` → `validateEnv()` → helmet
  (CSP `default-src 'none'`, HSTS в prod, CORP same-site) → cookie-parser →
  `express.json({limit:'2mb'})` → `csrfMiddleware` на `/api` → `auditMiddleware`
  на `/api` (после CSRF: отбитое на CSRF в журнал не попадает) → per-router
  `authMiddleware` (JWT в httpOnly-cookie) → per-router `requireAdmin` →
  zod `validateBody` (`middleware/validate.ts`).
- Инициализация: `initEncryption()` и `await getDb()` до монтирования роутов;
  фейл любого — `process.exit(1)`.
- Error handling: глобальный `errorHandler` (`index.ts:103`). **UserError**
  (`services/errors.ts`) отдаётся клиенту как есть со своим статусом (логируется
  `warn`); всё остальное логируется целиком (`'Unhandled error'`) и отдаётся как
  обезличенное `{ error: 'Internal server error' }`. Хендлеры try/catch не используют.
- `uncaughtException` / `unhandledRejection` логируются, но процесс не убивают.
- Background: `statsWorker` — опрос статистики раз в `STATS_POLL_INTERVAL_MS`
  (60 с), плюс каждые 6 ч purge `client_stats` и `audit_log`; на каждом тике
  дёргает `enforceLimits()` (срок жизни и суточный трафик клиентов).
- Graceful shutdown SIGTERM/SIGINT: `stopStatsWorker` → `flushSave`
  (WAL checkpoint) → `disconnectAll` SSH, форс-выход через 10 с.
- `GET /api/health` — без auth и CSRF (docker healthcheck).

### Routes (mounted под /api; subscriptions дополнительно с `/`)
Итого **59** обработчиков + `/api/health`. Все роутеры кроме `auth` требуют
`authMiddleware`; все кроме `auth` и `clients` — ещё и `requireAdmin`
(в `clients` админ-only только `PUT /:id/limits`).

| Mount | File | Endpoints |
|---|---|---|
| /api/auth | routes/auth.ts | 5: `POST /setup`, `GET /status`, `POST /login` (rate-limit), `POST /logout`, `GET /me` |
| /api/users | routes/users.ts | 4: `GET /`, `POST /`, `PUT /:id`, `DELETE /:id` (→ `{ ok, orphanedClients }`). Админский; публичной регистрации нет |
| /api/dashboard | routes/dashboard.ts | 2: `GET /` (сводка целиком из БД, без SSH), `POST /probe` (единственный SSH дашборда — по кнопке) |
| /api/audit | routes/audit.ts | 1: `GET /` с фильтрами `username/action/status/since/limit(≤200)/offset` → `{ rows, total, retentionDays, usernames, actions }`. Только чтение |
| /api/servers | routes/servers.ts | 13: CRUD (`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`), `POST /:id/test`, `POST /:id/ensure-docker`, `POST /:id/update-system`, `GET/POST/DELETE /:id/dns`, `GET /:id/containers`, `POST /:id/scan-protocols`, `POST /:id/import-protocol` |
| /api/protocols | routes/protocols.ts | 12: `GET /` (каталог PROTOCOLS), `GET /server/:serverId`, `GET /server/:serverId/health` → `{ statuses, drift }`, `POST /server/:serverId` (install), **`POST /:id/settings`** (Xray на живую → `{ protocol, reissued }`), `DELETE /:id`, `POST /:id/start|stop`, `GET /:id/status`, `GET /:id/stats-status`, `POST /:id/enable-stats`, `GET /:id/logs` |
| /api/clients | routes/clients.ts | 12: `POST /`, `GET /protocol/:protocolId` (с `owner_username`), **`GET /mine`**, **`GET /available-protocols`**, **`PUT /:id/limits`** (admin), `GET /:id/config`, `/config-amnezia`, `/config-text`, `/qr`, `/subscription`, `/stats?range=`, `DELETE /:id` (с отзывом peer'а на сервере) |
| /api/subscriptions + `/` | routes/subscriptions.ts | 9: публичный `GET /sub/:slug` (rate-limit), `GET /`, `DELETE /:id`, `GET/POST /template`, `POST /template/reset`, `POST /regenerate`, `GET/POST /settings` |
| **/api/disk** | **routes/disk.ts** | **2: `GET /:serverId` → `DiskReport`, `POST /:serverId/clean` `{item}` → `DiskReport & {output}`. Роутер целиком admin: команды идут под sudo и удаляют файлы** |

`POST /protocols/server/:serverId` возвращает строку протокола целиком (как
`GET /server/:serverId`) — фронт кладёт ответ прямо в список.

### Services (`backend/src/services/`)
- `db.ts` — better-sqlite3, `DB_PATH` (по умолчанию `../../data/panel.db`),
  `journal_mode=WAL`, `synchronous=NORMAL`; `query/queryOne/run`, `initSchema`,
  миграции `addColumn` и бэкфилл (`clients.peer_id`), шифрование секретов при
  записи. `save()` — no-op, `flushSave()` делает `wal_checkpoint(TRUNCATE)`.
- `errors.ts` — `UserError` (текст предназначен пользователю) + `isUserError`.
- `crypto.ts` — AES-256-GCM, ключ `PANEL_ENCRYPTION_KEY`; `encrypt/decrypt/isEncrypted`.
- `env.ts` — валидация окружения при старте (отказ на слабых `JWT_SECRET`).
- `ssh.ts` — node-ssh, пул соединений, реконнект по «мёртвым» сообщениям;
  `exec` / `execSudo` / `disconnectAll`.
- `shell.ts` — валидаторы ввода в shell: `assertContainerName`, `assertPort`,
  `assertDomain`, `assertWgKey`, `assertMagicHeader`, `assertUint32Range`,
  `assertXrayPath`, `assertXhttpMode`, `sh`, `shInt`. Бросают `UserError`.
- `access.ts` — RBAC: `isAdmin`, `canAccessClient`, `quotaReached`,
  `grantedProtocolIds`, `canUseProtocol`, `setUserProtocols`,
  `revokeProtocolGrants/revokeUserGrants`, `accessibleProtocols`, `countUserClients`.
  Доступ юзера выдаётся протоколами (`user_protocols`); сервер выводится из
  `protocols.server_id` — таблицы user_servers нет by design.
- `limits.ts` — срок жизни и суточный трафик клиента: `dayStartSec` (зависит от
  `TZ`), `isExpired`, `isOverDailyLimit`, `shouldResume`, `usedToday`,
  `enforceLimitsForClient`, `enforceLimits`. Срок — жёсткий (удаление клиента и
  пира), суточный лимит — мягкий (пир снимается и возвращается в новые сутки).
- `clientLifecycle.ts` — серверные операции над клиентом: отзыв пира, возврат
  пира, полное удаление. Общие для роутов и фонового воркера (расхождение
  «удалён в панели, работает на сервере» — дыра, а не косметика).
- `dashboard.ts` — сводка главной целиком из БД (`buildDashboard`), чистые
  `dayKey`, `trafficByDay`, `trafficByClient`, `fillMissingDays`, `hourlySamplesSince`.
- `serverProbe.ts` — единственный SSH ради дашборда и только по кнопке:
  `parseHostMetrics`, `probeServer`, `probeAllServers`, кэш `cacheDnsStatus`,
  `cacheDrift` (результат живёт в таблице `servers`/`protocols`).
- `audit.ts` — журнал действий: `recordAudit`, `describeAction` (метод+путь →
  `action`/`target_type`), `listAudit`, `auditFacets`, `purgeOldAudit`,
  `AUDIT_RETENTION_DAYS` (`AUDIT_RETENTION_DAYS`, дефолт 90). Тела запросов не
  пишутся принципиально (пароли, ключи, slug'и).
- **`disk.ts`** — **место на VPS: фиксированный `DISK_ITEMS` (9 пунктов:
  build-cache, docker-images, docker-logs, apt-cache, journal, old-logs,
  old-packages, root-cache, tmp), у каждого свои `sizeCmd`/`cleanCmd`/`hint`.
  Все размеры за один SSH-заход (`sizeScript`), парсинг — чистые `toBytes` и
  `parseReport`; `collectDisk`, `cleanDiskItem`. `cleanCmd` намеренно уезжает на
  фронт: админ должен видеть, что выполнится под sudo. Код возврата очистки не
  проверяется (пустой список у truncate/find даёт ненулевой код).**
- `logger.ts` — pino (pino-pretty вне prod), `LOG_LEVEL`.
- `peerId.ts` — извлечение peer_id из stored config (pubkey / UUID / secret).
- `amneziaExport.ts` — Amnezia-формат: JSON, `vpn://` URI, chunked QR (qCompress).
- `subscription.ts` — Clash YAML подписки (шаблон в `settings.clash_template`), slug'и.
- `statsWorker.ts` — периодический опрос протоколов (одно SSH-соединение на
  сервер), накопительные снимки в `client_stats`, purge + `enforceLimits`.
- `statsAggregate.ts` — чистые функции над снимками: сумма положительных
  приращений (не последний снимок), downsample, rate-серии.

### Middleware (`backend/src/middleware/`)
- `auth.ts` — `AUTH_COOKIE=panel_token`, `CSRF_COOKIE=panel_csrf`,
  `CSRF_HEADER=x-csrf-token`; `signToken`, `setAuthCookies`/`clearAuthCookies`,
  `authMiddleware` (роль дочитывается из БД на каждом запросе — в JWT её нет
  специально), `requireAdmin`, `csrfMiddleware` (GET пропускает).
- `audit.ts` — авто-запись по событию `finish` (а не в хендлерах): известны и
  код ответа, и `req.user`; отказы 401/403/404 пишутся тоже. Хендлеры только
  дополняют запись через `auditTarget()` / `auditDetails()`.
- `validate.ts` — фабрика валидации `req.body` по zod-схеме (body заменяется на
  parsed с применёнными default'ами).

### Protocols (`backend/src/services/protocols/`)
Диспетчер — barrel `index.ts`. `ProtocolType = 'awg2' | 'wireguard' | 'xray' | 'telemt'`.

| Protocol | File | install / addClient notes |
|---|---|---|
| awg2 (AmneziaWG) | awg2.ts | userspace amneziawg-go. Обфускация: Jc/Jmin/Jmax, S1-S4 (>=12), H1-H4, I1-I5. **AWG 3.0**: `HeaderProtectionKey` (server-side) + client-side `contentPaddingAddition`, `rekeyAfterTime/Timeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts`; `config.protocolVersion` = `'3'` при header protection, иначе `'2'`. Механика — через `wgCommon`. |
| wireguard | wireguard.ts | kernel-модуль `wireguard` (alpine + wireguard-tools); свой `start.sh` в `/opt/amnezia/wireguard/`. Механика — через `wgCommon`. |
| xray | xray.ts | VLESS; `security` = `reality` или `none`, транспорт `tcp` (flow xtls-rprx-vision) или `xhttp` (SplitHTTP, без flow); настраиваемые `sni`/`fingerprint`/`flow` меняются на живом протоколе через `applyXraySettings` (клиентские конфиги перевыпускаются, uuid сохраняются). addClient правит server.json в контейнере + restart; stats через StatsService API. vless обязан быть `inbounds[0]`. |
| telemt | telemt.ts | Telegram MTProto-прокси с FakeTLS; клиент = отдельный secret → `tg://proxy`. |
| — | wgCommon.ts | общая механика WG/AWG: `WgFlavor` (tool/iface/confDir/container/image/buildDir), `wgRunArgs`, `installWgLike`, `genPeerKeys`, `nextClientIp`, `addPeer`, `removePeer`, `assertContainerRunning`. |
| — | common.ts | `prepareHost` (ip_forward + сеть `amnezia-dns-net`), `assertPortFree`, `buildImage` (по sha Dockerfile), `runContainer` + `RUN_ARGS_LABEL`/`runArgsSha`, `writeRemoteFile`/`readRemoteFile`/`readContainerFile` (base64), `renderTemplate`, `removePeerBlock`, rand*. |
| — | containers.ts | статусы контейнеров (`getContainersHealth` — один SSH-вызов), start/stop/remove/logs, `listAmneziaContainers`, `ensureDocker`, `scanExistingProtocols`, каталог `PROTOCOLS`. |
| — | dockerfiles.ts | JS template literals: Dockerfile'ы + start/configure-скрипты + шаблоны клиентских конфигов (следить за экранированием). |
| — | stats.ts | per-peer трафик: `readAwgWgPeerStats`, `readXrayPeerStats`, `readTelemtPeerStats`, `isXrayStatsEnabled`, `enableXrayStats`. |
| — | dns.ts | AmneziaDNS (unbound, DoT наружу), фиксированный IP `172.29.172.254`. |
| — | drift.ts | сравнивает метки образа (`panel.dockerfile-sha`) и контейнера (`panel.run-sha`) с тем, что панель поставила бы сейчас; отдаёт `{ image, runArgs }` на протокол. Один SSH-вызов на все контейнеры; падение не роняет health. |

### Pinned images (как ЗАДУМАНО, не как развёрнуто)
| Протокол | FROM в dockerfiles.ts | Тег собираемого образа |
|---|---|---|
| awg2 | `amneziavpn/amneziawg-go:3.0.3` | `amnezia-awg2:3.0.3` |
| wireguard | `alpine:3.15` (+ wireguard-tools из apk) | `amnezia-wireguard:latest` |
| xray | `alpine:3.15`, `ARG XRAY_RELEASE="v25.8.3"` | `amnezia-xray:latest` |
| telemt | `debian:12-slim`, `TELEMT_VERSION="3.4.25"` (**версия прибита**, раньше был `releases/latest`) | `amnezia-telemt:latest` |
| dns | `mvance/unbound:1.22.0` | `amnezia-dns:latest` |

_Пометки про `:latest`:_ локальные теги `amnezia-*:latest` — наши собственные,
дрейфа апстрима не несут (образ пересобирается при смене sha Dockerfile).
Все апстрим-версии сейчас прибиты: `amneziavpn/amneziawg-go:latest` однажды
уехал с 0.2.19 на 3.0.3 и сменил мажорную версию демона под живыми клиентами,
telemt по той же причине переведён с `releases/latest` на 3.4.25. При бампе
версии awg2 менять и `FROM`, и `imageName` (`awg2.ts`, `drift.ts`).
Что реально крутится на сервере — вопрос рантайма, его решает `drift.ts`, не этот файл.

### Data
- DB: sqlite через better-sqlite3, `DB_PATH=/data/panel.db` (в контейнере), WAL.
- Таблицы: `servers`, `protocols` (+ `last_poll_at`), `clients` (+ `peer_id`,
  `user_id`, `expires_at`, `daily_limit_bytes`, `suspended_at`), `client_stats`
  (PK `(client_id, ts)`, индекс по `ts`), `users` (+ `role`, `client_limit`,
  `default_expiry_days`, `default_daily_limit_mb`), `user_protocols`
  (PK `(user_id, protocol_id)`), `subscriptions`, `settings`, `audit_log`
  (индексы по `ts DESC` и `user_id`; имена — снимки, чтобы пережить удаление).
  Внешние ключи с `ON DELETE CASCADE`.
- Секреты (SSH-пароли/ключи) шифруются `PANEL_ENCRYPTION_KEY` в `services/crypto.ts`.

### Тесты
vitest, 13 файлов `*.test.ts` рядом с модулями: `shell`, `peerId`,
`amneziaExport`, `statsAggregate`, `db`, `access`, `audit`, `dashboard`,
`limits`, **`disk`**, `protocols/common`, `protocols/awg2`,
`protocols/xrayTemplate`. Плюс `src/test-setup.ts` — изолирует тесты от боевой
базы. Покрывают чистые функции (валидаторы, рендер шаблонов, агрегация,
run-args, парсинг размеров диска) — там и случались баги.

## Frontend
- Build: Vite (`vite --port 3000` dev с proxy `/api` и `/sub` на :3001, `vite build`).
- Entry `src/main.tsx` → `src/App.tsx`.
- Routes (react-router-dom): `/setup` → SetupPage, `/login` → LoginPage,
  `/` → HomePage (админу DashboardPage, юзеру MyClientsPage), `/servers` →
  ServersPage, `/server/:id` → ServerPage, `/subscriptions` →
  SubscriptionsPage, `/users` → UsersPage, **`/disk` → DiskPage**, `/audit` →
  AuditPage. Приватные — через `PrivateLayout` (флаг `adminOnly` уводит юзера на `/`).
- `src/auth.ts` — `AuthContext` / `useCurrentUser` (текущий пользователь из `/auth/me`).
- API client: `src/api.ts` — axios `baseURL: '/api'`, `withCredentials`,
  double-submit CSRF (cookie `panel_csrf` → заголовок `X-CSRF-Token` на не-GET),
  редирект на `/login` при 401, хелпер `downloadWithAuth`. Группы: `authApi`,
  `usersApi`, `dashboardApi`, `auditApi`, **`diskApi`**, `serversApi`,
  `protocolsApi`, `clientsApi`, `subscriptionsApi`. Типы: `ServerRecord`,
  `ProtocolRecord`, `ClientRecord`/`ClientLimits`, `MyClientRecord`,
  `AvailableProtocol`, `PanelUser`, `CurrentUser`, `DashboardSummary`,
  `AuditRecord`/`AuditResponse`, **`DiskReport`/`DiskReportItem`**,
  `ProtocolDrift`, `HealthResponse`, `XraySettingsPayload`.
- `src/protocols.ts` — единственный источник отображаемых названий и иконок
  (`PROTOCOL_ICONS`, `PROTOCOL_NAMES`, `protocolTitle`). Заголовок карточки
  выводится из `type + config` (awg2 → «AmneziaWG 3.0» / «2.0» по
  `protocolVersion`), а НЕ из `protocols.name` в БД.
- Pages (`src/pages/`): `LoginPage`, `SetupPage`, `AuthForm`, `DashboardPage`,
  `MyClientsPage`, `ServersPage`, `ServerPage`, `SubscriptionsPage`,
  `UsersPage`, `AuditPage`, **`DiskPage`** (выбор сервера → таблица пунктов с
  размером, подсказкой, показом sudo-команды и кнопкой очистки у каждого).
- `pages/server/`: ProtocolCard, InstallProtocolModal, AddClientModal,
  ClientModal, ClientLimitsModal, LimitBadges, LimitFields, EditServerModal,
  ScanProtocolsModal, XraySettingsModal, XrayOptionFields, StatsModal, StatsTab,
  Sparkline, CopySubButton + утилиты `clipboard.ts`, `format.ts` (`formatBytes`).

## Deploy / Env
- docker-compose: `backend` (build `./backend`, `PORT=3001`, volume `./data:/data`,
  healthcheck `wget /api/health`, только во внутренней сети `panel`), `frontend`
  (build `./frontend`, `${PANEL_PORT:-80}:80`, `depends_on: backend healthy`).
- `backend/Dockerfile` — двухстадийный (deps на node:20-alpine с python3/make/g++
  для better-sqlite3 → рантайм). dev-зависимости в финальном образе остаются
  намеренно: `tsc`/`vitest` нужны для гейта внутри контейнера (на хосте Node нет).
- `frontend/nginx.conf` — SPA-fallback, CSP без `unsafe-inline`, проксирование
  `/api/` и `/sub/` на `backend:3001`, `X-Forwarded-For` (Express с `trust proxy: 1`).
- Env: `JWT_SECRET`, `PANEL_ENCRYPTION_KEY`, `DB_PATH=/data/panel.db`, `PORT`,
  `TZ` (граница суток для суточного лимита), `PANEL_PORT`, `NODE_ENV`,
  `LOG_LEVEL`, `STATS_POLL_INTERVAL_MS` (60000), `STATS_RETENTION_DAYS` (30),
  `AUDIT_RETENTION_DAYS` (90).
- **Исходник НЕ bind-mounted** → деплой правок: `docker compose up -d --build <svc>`.
- **Рабочий каталог запущен на боевом VPS** — рядом крутятся прод-контейнеры
  (`amnezia-panel-backend/frontend`, `amnezia-xray`, `amnezia-wireguard`, …).

## Architecture Notes
- **Auth и роли:** первичная настройка через `/setup`; логин выдаёт JWT в
  httpOnly-cookie, CSRF double-submit на `/api` (GET пропускается). Роли:
  `admin` (всё, включая SSH-креды и установку протоколов) и `user`
  (самообслуживание: завести себе клиента на выданном протоколе, скачать конфиг,
  своя статистика). Роль в токен не кладётся — читается из БД на каждом запросе,
  чтобы разжалование действовало сразу.
- **Управление протоколом:** панель по SSH делает `prepareHost` (ip_forward +
  сеть `amnezia-dns-net`), проверяет свободность порта, собирает Docker-образ
  (`buildImage`, skip если sha Dockerfile совпал), пишет start/configure-скрипты
  через base64, запускает контейнер с меткой `panel.run-sha` и конфигурирует через
  `docker exec`. Клиенты добавляются правкой конфига внутри контейнера
  (`wg/awg set` + дозапись `[Peer]`, правка `server.json` у Xray, secret у telemt);
  удаление клиента отзывает peer на сервере и удаляет подписку.
- **Drift:** health-запрос попутно сверяет метки образа/контейнера с текущим кодом
  и показывает расхождение в UI — сигнал «переустанови протокол», не ошибка.
- **Лимиты клиентов:** срок (`expires_at`) — удаление клиента вместе с пиром;
  суточный трафик (`daily_limit_bytes`) — приостановка (пир снимается) с
  возвратом тем же ключом в новые сутки. Проверяет `enforceLimits` на каждом
  тике stats-воркера; те же действия доступны из роутов через `clientLifecycle`.
- **Дашборд:** считается целиком из БД (серверы, протоколы, клиенты, трафик,
  issues drifted/silent, storage, подписки). Метрики хоста и статус DNS — из
  ручного `POST /dashboard/probe`, кэшируются в таблице `servers`.
- **Журнал действий:** пишется middleware по факту завершения запроса, включая
  отказы; ретенция 90 дней, чистка в фоне; из интерфейса не редактируется.
- **Диск:** `/disk` показывает `df` и размеры девяти известных «растущих» мест
  одним SSH-заходом; очистка — по одной кнопке на пункт, команда видна админу
  заранее, после очистки отчёт пересобирается и возвращается вместе с выводом.
- **Экспорт клиента:** оригинальный `.conf` / VLESS-URI / `tg://proxy` + Amnezia
  `vpn://` и chunked QR (`amneziaExport.ts`); подписки Clash YAML на `/sub/<slug>`.
- **Статистика:** `statsWorker` снимает накопительные счётчики per-peer в
  `client_stats`; отображаемый трафик за период считается `statsAggregate.ts` как
  сумма положительных приращений между снимками (контейнер при рестарте обнуляет счётчики).
- **AmneziaDNS:** серверный unbound-резолвер (DoT наружу), фиксированный IP
  `172.29.172.254`; WG/AWG-клиенты автоматически получают его в `DNS =`.
