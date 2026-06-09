# Amnezia Panel

Веб-панель для управления VPN-сервером через Amnezia Docker-образы.
Альтернатива десктопному клиенту Amnezia в части серверного управления — работает в браузере и управляет VPS через SSH.

## Стек
- **Backend**: Node.js + TypeScript (tsx) + Express + node-ssh + sql.js + zod + pino
- **Frontend**: React 18 + TypeScript + Vite + React Router + @dnd-kit
- **Деплой**: Docker Compose (nginx во frontend-контейнере проксирует `/api/` и `/sub/` на backend)

---

## Быстрый старт

```bash
git clone <repo>
cd amnezia-panel

# Обязательно: задай JWT_SECRET (≥32 символа, не дефолт)
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "PANEL_PORT=8080" >> .env

docker compose up -d --build
```

Открой: `http://<IP>:8080`

При первом входе — создание аккаунта администратора.

---

## Поддерживаемые протоколы

| Протокол | Контейнер | Особенности |
|---|---|---|
| **AmneziaWG 2.0** (`awg2`) | `amnezia-awg2` (build локально) | WireGuard + расширенная DPI-обфускация (Jc/Jmin/Jmax/S1-S4/H1-H4/I1-I5) |
| **WireGuard** | `amnezia-wireguard` (build локально) | Классический WG без обфускации |
| **Xray VLESS Reality** | `amnezia-xray` (build локально) | VLESS + Reality, имитирует TLS трафик целевого SNI |

Docker-образы собираются на VPS из Dockerfile'ов, генерируемых backend'ом (см. `backend/src/services/protocols/dockerfiles.ts`) — это реверс-инжиниринг команд Amnezia Desktop.

---

## Возможности

- Добавление нескольких VPS (password или SSH key)
- SSH credentials шифруются AES-256-GCM перед записью в БД
- Тест SSH-соединения + проверка/автоустановка Docker (`Ensure Docker`)
- Установка протоколов с настраиваемыми параметрами (порт, обфускация AWG, SNI для Xray)
- Управление контейнерами (start / stop / delete / logs)
- Сканирование уже установленных Amnezia-протоколов на сервере и импорт их в БД панели
- Создание клиентов с генерацией конфига, AmneziaVPN-совместимым `vpn://` URI и QR-кодом
- Chunked QR-код в нативном формате Amnezia (sscanf через несколько кадров)
- Clash/FLClash YAML-подписки для Xray-клиентов: публичный URL `/sub/<slug>` с криптостойким slug (192 бита энтропии) и rate-limit
- Drag-and-drop порядка протокольных карточек, сохраняется в localStorage
- **Per-client статистика трафика** (AWG/WG/Xray): online-статус, last handshake, накопительный rx/tx, графики rx/tx rate за 1h/24h/7d/30d — без логирования посещаемых сайтов

---

## Структура

```
amnezia-panel/
├── backend/
│   ├── src/
│   │   ├── index.ts                — Express app, graceful shutdown
│   │   ├── types.ts                — доменные типы (Server, Protocol, Client, ...)
│   │   ├── middleware/
│   │   │   ├── auth.ts             — JWT cookie + double-submit CSRF
│   │   │   └── validate.ts         — zod-схема → 400 с понятным error.path
│   │   ├── routes/
│   │   │   ├── auth.ts             — login / setup / me / logout
│   │   │   ├── servers.ts          — CRUD + scan + import
│   │   │   ├── protocols.ts        — install / start / stop / health / logs
│   │   │   ├── clients.ts          — create / qr / config / download
│   │   │   └── subscriptions.ts    — Clash подписки + публичный /sub/:slug
│   │   ├── services/
│   │   │   ├── db.ts               — sql.js + debounced disk snapshots
│   │   │   ├── crypto.ts           — AES-256-GCM для SSH-кредов
│   │   │   ├── ssh.ts              — node-ssh connection pool + keepalive
│   │   │   ├── shell.ts            — sh()/shInt()/assert* для безопасной интерполяции
│   │   │   ├── env.ts              — валидация JWT_SECRET на старте
│   │   │   ├── logger.ts           — pino (JSON в prod, pretty в dev)
│   │   │   ├── subscription.ts     — генерация Clash YAML
│   │   │   ├── amneziaExport.ts    — vpn:// URI + Amnezia JSON + chunked QR
│   │   │   ├── peerId.ts           — extractPeerId() — pubkey/UUID из stored config
│   │   │   ├── statsWorker.ts      — фоновый поллер per-client статистики
│   │   │   └── protocols/
│   │   │       ├── index.ts        — barrel re-export
│   │   │       ├── common.ts       — randInt, writeRemoteFile, buildImage
│   │   │       ├── containers.ts   — docker lifecycle + scanExistingProtocols
│   │   │       ├── dockerfiles.ts  — шаблоны Dockerfile'ов и start/configure скриптов
│   │   │       ├── stats.ts        — readAwgWgPeerStats (awg/wg show … dump)
│   │   │       ├── awg2.ts         — install + addClient
│   │   │       ├── wireguard.ts    — install + addClient
│   │   │       └── xray.ts         — install + addClient
│   │   └── templates/
│   │       └── clash.yaml          — дефолтный Clash YAML template
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                 — роутинг + sidebar
│   │   ├── App.css                 — все стили в одном файле
│   │   ├── api.ts                  — axios + CSRF + типы API
│   │   └── pages/
│   │       ├── LoginPage.tsx
│   │       ├── SetupPage.tsx
│   │       ├── AuthForm.tsx        — общая форма login/setup
│   │       ├── DashboardPage.tsx
│   │       ├── ServerPage.tsx      — главная страница сервера (тонкий контейнер)
│   │       ├── SubscriptionsPage.tsx
│   │       └── server/             — компоненты ServerPage
│   │           ├── ProtocolCard.tsx
│   │           ├── ClientModal.tsx
│   │           ├── AddClientModal.tsx
│   │           ├── EditServerModal.tsx
│   │           ├── InstallProtocolModal.tsx
│   │           ├── ScanProtocolsModal.tsx
│   │           ├── CopySubButton.tsx
│   │           ├── clipboard.ts
│   │           ├── format.ts        — formatBytes / formatBitsPerSec / ...
│   │           ├── Sparkline.tsx    — минималистичный SVG-чарт
│   │           ├── StatsTab.tsx     — содержимое статистики (online, rx/tx, графики)
│   │           └── StatsModal.tsx   — модалка статистики (кнопка 📊 Stats в строке клиента)
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── Dockerfile
├── data/                           — БД + encryption.key (создаётся автоматически)
└── docker-compose.yml
```

---

## API

### Health
```
GET  /api/health           — { ok: true } (без auth, used by docker compose healthcheck)
```

### Auth
```
GET  /api/auth/status      — нужна ли первичная настройка
POST /api/auth/setup       — создать admin (только если БД пустая)
POST /api/auth/login       — выставить httpOnly cookie + CSRF cookie
POST /api/auth/logout      — очистить cookies
GET  /api/auth/me          — { username } для проверки сессии
```

### Servers
```
GET    /api/servers                       — список
POST   /api/servers                       — добавить
PUT    /api/servers/:id                   — обновить
DELETE /api/servers/:id                   — удалить
POST   /api/servers/:id/test              — тест SSH
POST   /api/servers/:id/ensure-docker     — установить Docker через get.docker.com
GET    /api/servers/:id/containers        — список Amnezia-контейнеров
POST   /api/servers/:id/scan-protocols    — найти установленные протоколы
POST   /api/servers/:id/import-protocol   — импортировать найденный протокол + клиентов
```

### Protocols
```
GET    /api/protocols                                — описания (для UI)
GET    /api/protocols/server/:serverId               — установленные на сервере
GET    /api/protocols/server/:serverId/health        — реальные статусы (батчем за 1 SSH)
POST   /api/protocols/server/:serverId               — установить { type, options }
DELETE /api/protocols/:id                            — удалить + контейнер + клиенты
POST   /api/protocols/:id/start                      — запустить
POST   /api/protocols/:id/stop                       — остановить
GET    /api/protocols/:id/status                     — статус одного
GET    /api/protocols/:id/logs?lines=100             — логи контейнера
GET    /api/protocols/:id/stats-status               — { statsEnabled }
                                                       (AWG/WG always true; Xray читает server.json)
POST   /api/protocols/:id/enable-stats               — только для Xray:
                                                       jq-патч server.json + restart контейнера
```

### Clients
```
GET    /api/clients/protocol/:protocolId   — список
POST   /api/clients                         — создать { protocolId, name }
DELETE /api/clients/:id                     — удалить
GET    /api/clients/:id/qr                  — QR (оригинальный + amneziaQrParts + vpnUri)
GET    /api/clients/:id/config-text         — { config, vpnUri, name }
GET    /api/clients/:id/config              — скачать .conf / .txt
GET    /api/clients/:id/config-amnezia      — скачать Amnezia JSON
GET    /api/clients/:id/subscription        — { slug } для Xray-клиентов
GET    /api/clients/:id/stats?range=1h|24h|7d|30d  — per-client traffic stats
                                              (online, lastHandshake, totalRx/Tx, series[])
```

### Subscriptions
```
GET    /sub/:slug                          — публичный YAML для Clash/FLClash (rate-limit 30/min)
GET    /api/subscriptions                  — список (auth)
DELETE /api/subscriptions/:clientId        — удалить подписку
GET    /api/subscriptions/template         — { template, default }
POST   /api/subscriptions/template         — { template } сохранить
POST   /api/subscriptions/template/reset   — вернуть дефолтный шаблон
POST   /api/subscriptions/regenerate       — перегенерировать все подписки из текущего шаблона
GET    /api/subscriptions/settings         — { vpsHost }
POST   /api/subscriptions/settings         — { vpsHost } сохранить
```

---

## Переменные окружения

| Переменная | Default | Описание |
|---|---|---|
| `JWT_SECRET` | **обязательно** | Секрет для JWT, минимум 32 символа. Сгенерировать: `openssl rand -hex 32`. Известные дефолт-значения отвергаются на старте. |
| `PANEL_ENCRYPTION_KEY` | автогенерация | 64 hex-символа (32 байта) для AES-GCM шифрования SSH-кредов. Если не задан — генерируется и сохраняется в `data/encryption.key` (берегите файл при бэкапах). |
| `PANEL_PORT` | `80` | Внешний порт веб-панели (`docker-compose.yml`). |
| `DB_PATH` | `/data/panel.db` | Путь к базе данных. |
| `NODE_ENV` | `development` | В `production` включает HSTS и JSON-логи pino. |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | Уровень логов pino. |
| `STATS_POLL_INTERVAL_MS` | `60000` | Интервал snapshot'ов client_stats в миллисекундах. |
| `STATS_RETENTION_DAYS` | `30` | Сколько дней хранить точки client_stats; старше — purge каждые 6ч. |

---

## Статистика клиентов

Раз в минуту backend опрашивает все запущенные VPN-контейнеры и сохраняет
per-peer cumulative rx/tx + last_handshake в таблицу `client_stats`. Мап
peer-id → client делается через колонку `clients.peer_id`, которая
заполняется на создании / импорте клиента.

**Источники данных по протоколам:**

| Протокол | Команда | Per-user счётчик |
|---|---|---|
| AmneziaWG / WireGuard | `awg\|wg show <iface> dump` | public key |
| Xray VLESS Reality | `xray api statsquery -pattern user>>>` через 127.0.0.1:10085 | email (== UUID) |

**Что в UI:** в строке клиента кнопка **📊 Stats** → модалка:
- online/offline + last handshake (для Xray синтезируется из дельты трафика)
- накопительные rx/tx (сбрасываются при рестарте VPN-контейнера)
- график rx/tx rate за 1 ч / 24 ч / 7 дней / 30 дней

**Xray и существующие установки:** новые Xray-протоколы ставятся уже с включённым
stats-API (см. `CONFIGURE_SCRIPTS.xray`). Старые протоколы — на их карточке появляется
кнопка **📊 Enable stats**: бэкенд через `jq` дописывает блоки `stats`, `api`,
`policy`, `routing` в `server.json` и рестартит контейнер (даунтайм ~3 сек,
существующие клиенты сохраняются, email-поле бэкфиллится автоматически).

**Чего нет (и не будет в этой версии):** логирование посещаемых доменов / DNS-запросов
/ SNI-сниффинг. Намеренно — обходится встроенным DoH в браузерах, нагружает
CPU, заметная privacy-проблема при раздаче доступа другим людям.

Tuning: `STATS_POLL_INTERVAL_MS` и `STATS_RETENTION_DAYS` (см. выше).

---

## Безопасность

- SSH credentials (password, private_key) шифруются AES-256-GCM перед записью в БД, ключ — в `data/encryption.key` или `PANEL_ENCRYPTION_KEY`
- JWT в httpOnly cookie + CSRF double-submit cookie (`X-CSRF-Token` header против `panel_csrf` cookie)
- Rate-limit: 10 попыток логина / 15 мин, 30 запросов / мин на `/sub/:slug`
- Slug подписки = 192 бита криптослучайных байт в base64url
- CSP в двух слоях: nginx отдаёт строгий CSP на HTML (`default-src 'self'`, без `unsafe-eval`); backend через helmet отдаёт `default-src 'none'` на JSON-ответах (defense-in-depth)
- same-site cookie + HSTS в production
- Все user input в SSH-командах проходят через `shell.ts` (`sh()`, `shInt()`, `assertContainerName()`, `assertPort()`)
- zod-валидация на всех POST/PUT с пользовательскими данными
- docker compose healthcheck (`/api/health`): nginx не начинает проксировать до того, как backend готов отвечать

---

## Дев-режим

```bash
# Backend
cd backend
npm install
JWT_SECRET=$(openssl rand -hex 32) npm start          # tsx watch
npm run typecheck                                      # tsc --noEmit

# Frontend
cd frontend
npm install
npm run dev                                            # vite на :3000, проксирует /api → :3001
npm run typecheck
```

---

## Roadmap

- [ ] Shadowsocks
- [ ] OpenVPN over Cloak
- [ ] IKEv2/IPSec
- [ ] Удалённое управление настройками AWG (без передеплоя)
