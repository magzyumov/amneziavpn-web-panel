# Amnezia Panel

**Веб-панель для управления собственным VPN-сервером.** Ставит и настраивает
VPN-протоколы на ваших VPS по SSH, выпускает клиентские конфиги и следит за
трафиком — всё из браузера, без десктопного клиента.

Панель говорит с сервером на том же языке, что и официальный клиент AmneziaVPN:
контейнеры, пути и параметры обфускации восстановлены по его поведению, поэтому
выпущенные конфиги импортируются в приложение Amnezia как родные — ссылкой
`vpn://` или QR-кодом.

```
┌─────────────┐      HTTPS       ┌──────────────┐       SSH       ┌─────────────┐
│   Браузер   │ ───────────────► │ Amnezia      │ ──────────────► │  Ваш VPS    │
│             │                  │ Panel        │                 │  (Docker)   │
└─────────────┘                  └──────────────┘                 └─────────────┘
                                        │                          amnezia-awg2
                                   sqlite (панель)                 amnezia-xray
                                                                   amnezia-wireguard
                                                                   amnezia-telemt
                                                                   amnezia-dns
```

---

## Что умеет

- **Несколько серверов** в одной панели. SSH по паролю или ключу, креды шифруются AES-256-GCM.
- **Установка протоколов в один клик** — панель сама поставит Docker, подготовит хост и соберёт образы на VPS.
- **Импорт того, что уже стоит**: сканирует сервер, находит развёрнутые контейнеры (AmneziaWG, WireGuard, Xray, Telemt) и подхватывает их вместе с клиентами.
- **Клиентские конфиги** — файл, `vpn://`-ссылка, QR (включая нативный многокадровый QR Amnezia), `tg://proxy` для Telegram.
- **Подписки Clash/FLClash** для Xray-клиентов: публичный URL с криптостойким slug и настраиваемым YAML-шаблоном.
- **Статистика по клиентам** — принято/отправлено за период, онлайн-статус, графики скорости. Без логирования того, куда ходит пользователь.
- **Отзыв доступа**: удаление клиента снимает peer на сервере, а не только строку в базе.

---

## Быстрый старт

Нужен только Docker и Docker Compose — на машине с панелью. Node и прочее ставить не надо.

```bash
git clone https://github.com/magzyumov/amneziavpn-web-panel.git
cd amneziavpn-web-panel

# JWT_SECRET обязателен: без него панель не стартует, дефолтные значения отвергаются
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "PANEL_PORT=8080" >> .env

docker compose up -d --build
```

Откройте `http://<IP>:8080` — при первом входе панель предложит создать администратора.

> [!IMPORTANT]
> Панель отдаётся по HTTP. Если она смотрит в интернет, поставьте её за reverse-proxy
> с TLS или ограничьте доступ по IP — иначе пароль и сессия ходят открытым текстом.

---

## Протоколы

| Протокол | Что это | Особенности |
|---|---|---|
| **AmneziaWG 3.0** | WireGuard с обфускацией под DPI | Junk-пакеты (`Jc/Jmin/Jmax`), паддинг `S1-S4`, диапазонные заголовки `H1-H4`, сигнатурные пакеты `I1-I5` и **защита заголовков** (`HeaderProtectionKey`) |
| **Xray VLESS Reality** | Маскировка под TLS чужого сайта | Транспорт `tcp` (с `xtls-rprx-vision`) или `xhttp`, произвольный SNI, per-client UUID |
| **WireGuard** | Классический WG | Без обфускации — быстрый, но узнаваемый для DPI |
| **Telemt** | Telegram-прокси MTProto | Обязательная FakeTLS-маскировка, per-client секреты и `tg://`-ссылки |
| **AmneziaDNS** | Резолвер на стороне сервера | unbound с DNS-over-TLS наружу; клиентам WG/AWG прописывается автоматически |

Образы собираются прямо на VPS из Dockerfile'ов, которые генерирует backend
(`backend/src/services/protocols/dockerfiles.ts`). Версии базовых образов
**прибиты**: обновление upstream не может молча подменить версию демона под
работающими клиентами.

Образ и контейнер помечаются отпечатками шаблона и аргументов запуска. Если код
уехал вперёд, панель пересоберёт образ при следующей установке, а на карточке
протокола покажет **⟳ устарел** — значит на сервере работает не то, что описано
в репозитории, и протокол стоит переустановить.

### Про AmneziaWG 3.0

Header protection шифрует низкоэнтропийные поля заголовков — те самые, по которым
WireGuard опознаётся сигнатурным анализом. Паддинг `S1-S4` служит для этого nonce,
поэтому каждое из значений должно быть не меньше 12; панель следит за этим и в
генераторе, и в форме установки.

Параметр серверный: один и тот же ключ уходит и в конфиг сервера, и в клиентские
конфиги, включая `vpn://`-ссылку и QR. Клиентам со старых инсталляций (без
header protection) новые параметры не пишутся — их конфиги продолжают работать.

---

## Статистика

Раз в минуту фоновый воркер опрашивает запущенные контейнеры и складывает
снимки счётчиков в таблицу `client_stats`.

| Протокол | Источник | Ключ клиента |
|---|---|---|
| AmneziaWG / WireGuard | `awg\|wg show <iface> dump` | публичный ключ |
| Xray VLESS Reality | `xray api statsquery` через `127.0.0.1:10085` | email (== UUID) |
| Telemt | локальный JSON-API прокси | username; только суммарный трафик |

Счётчики в контейнерах накопительные, поэтому трафик **за выбранный период**
считается как сумма приращений внутри окна: рестарт VPN-контейнера обнуляет
счётчик, но не показанную статистику. В карточке клиента — кнопка **📊 Stats**:
онлайн-статус, last handshake, принято/отправлено за период и график скорости
за 1 час / 24 часа / 7 дней / 30 дней.

Для Xray-протоколов, установленных до появления stats-API, на карточке есть
кнопка **📊 Enable stats** — панель дописывает нужные блоки в `server.json`
через `jq` и перезапускает контейнер; клиенты при этом сохраняются.

**Чего панель не делает намеренно:** не логирует посещаемые домены, DNS-запросы
и SNI. Это нагружает CPU, обходится встроенным в браузеры DoH и создаёт заметную
проблему приватности, когда доступом пользуются другие люди.

---

## Безопасность

- SSH-креды шифруются **AES-256-GCM**; ключ — в `PANEL_ENCRYPTION_KEY` или в `data/encryption.key` (не забудьте про него при бэкапе).
- Сессия — JWT в httpOnly cookie плюс **CSRF double-submit**: заголовок `X-CSRF-Token` против cookie `panel_csrf`.
- Rate-limit: 10 попыток входа за 15 минут, 30 запросов в минуту на публичный `/sub/:slug`.
- Slug подписки — 192 бита криптослучайных данных в base64url.
- **Ничего не интерполируется в SSH-команды напрямую**: весь пользовательский ввод проходит через `services/shell.ts` (`sh()`, `shInt()`, `assertPort()`, `assertDomain()` и другие), а файлы на сервер пишутся через base64, минуя вопросы экранирования.
- zod-валидация на всех запросах с пользовательскими данными.
- CSP в два слоя: строгий заголовок от nginx на HTML (без `unsafe-inline` и `unsafe-eval` как для скриптов, так и для стилей) и `default-src 'none'` от helmet на JSON-ответах.
- Healthcheck в compose: nginx не начинает проксировать, пока backend не готов.

Ошибки, у которых есть внятная причина («порт занят контейнером X», «контейнер не
запущен»), доходят до интерфейса дословно. Всё остальное обезличивается до
`Internal server error`, а подробности остаются в логах.

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `JWT_SECRET` | **обязательна** | Секрет для JWT, минимум 32 символа: `openssl rand -hex 32`. Известные дефолты отвергаются на старте. |
| `PANEL_ENCRYPTION_KEY` | автогенерация | 64 hex-символа для шифрования SSH-кредов. Если не задана — создаётся `data/encryption.key`. |
| `PANEL_PORT` | `80` | Внешний порт панели. |
| `PORT` | `3001` | Порт backend внутри контейнера; compose задаёт его явно. |
| `DB_PATH` | `/data/panel.db` в Docker | Путь к базе. Дефолт в коде — `backend/data/panel.db`, он и действует при локальном `npm start`. |
| `NODE_ENV` | `development` | В `production` включает HSTS и JSON-логи. |
| `LOG_LEVEL` | `info` / `debug` | Уровень логирования (pino). |
| `STATS_POLL_INTERVAL_MS` | `60000` | Как часто снимать статистику. |
| `STATS_RETENTION_DAYS` | `30` | Сколько дней хранить снимки; старые чистятся раз в 6 часов. |

---

## Разработка

```bash
# Backend — Node 20+
cd backend
npm install
JWT_SECRET=$(openssl rand -hex 32) npm start   # tsx
npm run typecheck                              # tsc --noEmit
npm test                                       # vitest

# Frontend
cd frontend
npm install
npm run dev                                    # vite на :3000, проксирует /api → :3001
npm run typecheck
```

Тестами покрыты чистые функции, где ошибка тише всего и дороже всего: валидаторы
shell-ввода, рендер шаблонов конфигов, разбор peer-id, сборка экспорта в формат
Amnezia, генератор параметров обфускации и агрегация статистики.

<details>
<summary><b>Структура проекта</b></summary>

```
amneziavpn-web-panel/
├── backend/
│   └── src/
│       ├── index.ts                — Express app, graceful shutdown
│       ├── types.ts                — доменные типы (Server, Protocol, Client, …)
│       ├── middleware/
│       │   ├── auth.ts             — JWT cookie + double-submit CSRF
│       │   └── validate.ts         — zod-схема → 400 с понятным error.path
│       ├── routes/
│       │   ├── auth.ts             — login / setup / me / logout
│       │   ├── servers.ts          — CRUD + scan + import + AmneziaDNS
│       │   ├── protocols.ts        — install / start / stop / health / logs
│       │   ├── clients.ts          — create / qr / config / stats
│       │   └── subscriptions.ts    — Clash-подписки + публичный /sub/:slug
│       └── services/
│           ├── db.ts               — better-sqlite3 (WAL), схема и миграции
│           ├── crypto.ts           — AES-256-GCM для SSH-кредов
│           ├── ssh.ts              — пул соединений node-ssh + keepalive
│           ├── shell.ts            — sh()/shInt()/assert* для безопасной интерполяции
│           ├── errors.ts           — UserError: причина отказа доходит до UI
│           ├── env.ts              — валидация JWT_SECRET на старте
│           ├── logger.ts           — pino
│           ├── subscription.ts     — генерация Clash YAML
│           ├── amneziaExport.ts    — vpn:// URI + Amnezia JSON + многокадровый QR
│           ├── peerId.ts           — peer-id из сохранённого конфига
│           ├── statsWorker.ts      — фоновый сбор статистики
│           ├── statsAggregate.ts   — трафик за период, прореживание, скорости
│           ├── *.test.ts           — vitest рядом с проверяемыми модулями
│           └── protocols/
│               ├── index.ts        — barrel: через него импортируются протоколы
│               ├── common.ts       — общие хелперы, buildImage с отпечатком Dockerfile
│               ├── containers.ts   — docker lifecycle + scanExistingProtocols
│               ├── dockerfiles.ts  — шаблоны Dockerfile'ов и скриптов
│               ├── stats.ts        — снятие per-peer счётчиков
│               ├── drift.ts        — расхождение работающих контейнеров с кодом
│               ├── dns.ts          — AmneziaDNS
│               ├── wgCommon.ts     — общая механика WireGuard и AmneziaWG
│               ├── awg2.ts         — AmneziaWG (install + клиенты)
│               ├── wireguard.ts    — WireGuard
│               ├── xray.ts         — Xray VLESS Reality
│               └── telemt.ts       — Telegram-прокси
├── frontend/
│   └── src/
│       ├── api.ts                  — axios + CSRF + типы API
│       ├── protocols.ts            — названия и иконки протоколов
│       └── pages/                  — Dashboard, Server, Subscriptions + компоненты
│   └── templates/clash.yaml        — дефолтный шаблон Clash-подписки
├── data/                           — база и ключ шифрования (создаются сами)
└── docker-compose.yml
```
</details>

<details>
<summary><b>API</b></summary>

### Health
```
GET  /api/health           — { ok: true }, без авторизации (используется healthcheck'ом)
```

### Auth
```
GET  /api/auth/status      — нужна ли первичная настройка
POST /api/auth/setup       — создать администратора (только если база пустая)
POST /api/auth/login       — httpOnly cookie + CSRF cookie
POST /api/auth/logout      — очистить cookies
GET  /api/auth/me          — { username }
```

### Servers
```
GET    /api/servers                       — список
POST   /api/servers                       — добавить
PUT    /api/servers/:id                   — обновить
DELETE /api/servers/:id                   — удалить
POST   /api/servers/:id/test              — тест SSH
POST   /api/servers/:id/ensure-docker     — установить Docker
GET    /api/servers/:id/containers        — контейнеры Amnezia на сервере
POST   /api/servers/:id/scan-protocols    — найти установленные протоколы
POST   /api/servers/:id/import-protocol   — импортировать протокол вместе с клиентами
GET    /api/servers/:id/dns               — статус AmneziaDNS
POST   /api/servers/:id/dns               — установить
DELETE /api/servers/:id/dns               — удалить
```

### Protocols
```
GET    /api/protocols                          — каталог протоколов
GET    /api/protocols/server/:serverId         — установленные на сервере
GET    /api/protocols/server/:serverId/health  — { statuses, drift }: статусы контейнеров
                                                 одним SSH-вызовом + расхождение с кодом
POST   /api/protocols/server/:serverId         — установить { type, options }
DELETE /api/protocols/:id                      — удалить протокол, контейнер и клиентов
POST   /api/protocols/:id/start                — запустить
POST   /api/protocols/:id/stop                 — остановить
GET    /api/protocols/:id/status               — статус
GET    /api/protocols/:id/logs?lines=100       — логи контейнера
GET    /api/protocols/:id/stats-status         — { statsEnabled }
POST   /api/protocols/:id/enable-stats         — включить stats-API у Xray
```

### Clients
```
GET    /api/clients/protocol/:protocolId           — список
POST   /api/clients                                 — создать { protocolId, name }
DELETE /api/clients/:id                             — удалить и отозвать peer на сервере
GET    /api/clients/:id/qr                          — QR + vpn://
GET    /api/clients/:id/config-text                 — { config, vpnUri, name }
GET    /api/clients/:id/config                      — скачать .conf / .txt
GET    /api/clients/:id/config-amnezia              — скачать Amnezia JSON
GET    /api/clients/:id/subscription                — { slug } для Xray
GET    /api/clients/:id/stats?range=1h|24h|7d|30d   — трафик за период, онлайн, график
```

### Subscriptions
```
GET    /sub/:slug                          — публичный YAML для Clash/FLClash (30 запросов/мин)
GET    /api/subscriptions                  — список
DELETE /api/subscriptions/:clientId        — удалить подписку
GET    /api/subscriptions/template         — { template, default }
POST   /api/subscriptions/template         — сохранить шаблон
POST   /api/subscriptions/template/reset   — вернуть дефолтный
POST   /api/subscriptions/regenerate       — перегенерировать все подписки
GET    /api/subscriptions/settings         — { vpsHost }
POST   /api/subscriptions/settings         — сохранить хост для ссылок
```
</details>

---

## Благодарности

Проект опирается на работу команды [AmneziaVPN](https://github.com/amnezia-vpn):
протоколы [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go),
[amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) и подход к
развёртыванию из десктопного клиента. Панель — независимый инструмент и с
проектом Amnezia официально не связана.
