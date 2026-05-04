# Amnezia Panel

Веб-панель для управления VPN-сервером через Amnezia Docker-образы.
Альтернатива десктопному клиенту Amnezia в части серверного управления.

## Стек
- **Backend**: Node.js + Express + node-ssh + sql.js
- **Frontend**: React + Vite + React Router
- **Деплой**: Docker Compose

---

## Быстрый старт

```bash
git clone <repo>
cd amnezia-panel

# Опционально: смени JWT_SECRET
echo "JWT_SECRET=your-secret-here" > .env
echo "PANEL_PORT=8080" >> .env

docker compose up -d --build
```

Открой: `http://<IP>:8080`

При первом входе — создание аккаунта администратора.

---

## Поддерживаемые протоколы

| Протокол | Docker образ | Статус |
|---|---|---|
| **AmneziaWG** | `amneziavpn/amneziawg-go` | ✅ |
| **Xray VLESS Reality** | `amneziavpn/amnezia-xray-core` | ✅ |
| **OpenVPN** | `amneziavpn/openvpn-server` | ✅ |

---

## Возможности

- Добавление нескольких VPS (password или SSH key)
- Тест SSH-соединения + проверка Docker
- Автоустановка Docker (`Ensure Docker`)
- Установка протоколов с настраиваемыми параметрами (порт, обфускация AWG, SNI для Xray)
- Управление контейнерами (start/stop/delete)
- Просмотр логов контейнера в реальном времени
- Создание клиентов с генерацией конфига
- QR-код для каждого клиента
- Скачивание `.conf` файла

---

## Структура

```
amnezia-panel/
├── backend/
│   ├── src/
│   │   ├── index.js            — Express app
│   │   ├── middleware/auth.js  — JWT auth
│   │   ├── routes/
│   │   │   ├── auth.js         — login/setup
│   │   │   ├── servers.js      — CRUD серверов
│   │   │   ├── protocols.js    — установка/управление
│   │   │   └── clients.js      — клиенты + QR
│   │   └── services/
│   │       ├── db.js           — SQLite (sql.js)
│   │       ├── ssh.js          — SSH connection pool
│   │       └── protocols.js    — Docker команды
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── api.js              — axios API client
│   │   ├── App.jsx             — роутинг + стили
│   │   └── pages/
│   │       ├── LoginPage.jsx
│   │       ├── SetupPage.jsx
│   │       ├── DashboardPage.jsx
│   │       └── ServerPage.jsx
│   ├── nginx.conf
│   └── Dockerfile
├── data/                       — БД (создаётся автоматически)
└── docker-compose.yml
```

---

## API

### Auth
```
GET  /api/auth/status      — нужна ли настройка
POST /api/auth/setup       — создать admin
POST /api/auth/login       — получить JWT
```

### Servers
```
GET    /api/servers                    — список серверов
POST   /api/servers                    — добавить сервер
DELETE /api/servers/:id                — удалить
POST   /api/servers/:id/test           — тест SSH
POST   /api/servers/:id/ensure-docker  — установить Docker
GET    /api/servers/:id/containers     — список контейнеров
```

### Protocols
```
GET    /api/protocols                       — описания протоколов
GET    /api/protocols/server/:serverId      — протоколы сервера
POST   /api/protocols/server/:serverId      — установить { type, options }
DELETE /api/protocols/:id                   — удалить + контейнер
POST   /api/protocols/:id/start             — запустить
POST   /api/protocols/:id/stop              — остановить
GET    /api/protocols/:id/logs              — логи контейнера
```

### Clients
```
GET    /api/clients/protocol/:protocolId   — список клиентов
POST   /api/clients                         — создать { protocolId, name }
DELETE /api/clients/:id                     — удалить
GET    /api/clients/:id/qr                  — QR-код (base64)
GET    /api/clients/:id/config-text         — текст конфига
GET    /api/clients/:id/config              — скачать файл
```

---

## Переменные окружения

| Переменная | Default | Описание |
|---|---|---|
| `JWT_SECRET` | `change-me-in-production` | Секрет для JWT |
| `PANEL_PORT` | `8080` | Порт веб-панели |
| `DB_PATH` | `/data/panel.db` | Путь к базе данных |

---

## Добавление протоколов (roadmap)

- [ ] Shadowsocks
- [ ] OpenVPN over Cloak
- [ ] IKEv2/IPSec
- [ ] Euphoria (AWG-based)
- [ ] Импорт существующих конфигов Amnezia
