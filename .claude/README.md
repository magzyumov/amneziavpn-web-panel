# Claude Code — конфигурация для amneziavpn-web-panel

Эта директория — локальные настройки и агенты Claude Code для проекта.
`.claude/` в `.gitignore` (строка 23) — **не коммитится**, это личные настройки.

## Что это за проект

Web-панель управления AmneziaVPN. Backend по SSH ходит на удалённые VPS и
управляет Docker-контейнерами VPN-протоколов (WireGuard, AWG2, Xray, MTProxy,
Telemt). Данные — в локальной sqlite. Frontend — SPA-панель.

| Каталог     | Стек                          | Роль                                       |
|-------------|-------------------------------|--------------------------------------------|
| `backend/`  | Node 20 + TS (ESM), Express 4 | API, SSH→VPS, управление Docker, sqlite     |
| `frontend/` | React 18 + Vite + TS          | SPA, axios-клиент к backend (`src/api.ts`)  |

## Структура `.claude/`

```
.claude/
├── CLAUDE.md                 # главные инструкции (читаются автоматически)
├── README.md                 # этот файл
├── project-context.md        # снимок кодовой базы (генерирует project-scanner)
├── settings.local.json       # пермишены + Stop-hook (локальные)
├── hooks/
│   └── quality-gates.sh       # typecheck backend/frontend при изменении src
├── agents/
│   ├── project-scanner.md     # первичное сканирование → project-context.md
│   └── context-updater.md     # инкрементальные обновления контекста
└── agent-memory/              # память агентов (по проекту)
```

## Quality gate

Тестов в проекте нет — гейт это `npm run typecheck` в затронутом пакете.
Stop-hook `hooks/quality-gates.sh` запускается автоматически в конце хода, если
менялись `backend/src/**` или `frontend/src/**`, и при ошибке типов возвращает
`decision:"block"`. На хосте обычно нет node — хук для backend делает фолбэк:
typecheck внутри контейнера `amnezia-panel-backend`.

Вручную:
```bash
docker exec amnezia-panel-backend sh -c 'cd /app && npx tsc --noEmit'
cd frontend && npm run typecheck
```

## Деплой (важно!)

Рабочий каталог запущен **на боевом VPS**. Исходник backend не смонтирован в
контейнер — после правок нужна пересборка образа:

```bash
docker compose up -d --build backend     # или frontend
```

Реальный текст 500-х ошибок (в UI скрыт за `Internal server error`) — в логах:
```bash
docker logs amnezia-panel-backend 2>&1 | grep -A20 "Unhandled error"
```

## Агенты

### `project-scanner` — первичное сканирование
Обходит `backend/src` и `frontend/src`, пишет снимок в `.claude/project-context.md`.
Запускать один раз на проекте или после крупного рефактора.

### `context-updater` — инкрементальные обновления
После добавления роута/сервиса/протокола/страницы — точечно правит нужные секции
`project-context.md`. Передай хинт: `"added X route"`.

## Обычная работа

Просто пиши задачу на естественном языке. Claude прочитает `project-context.md`
(если есть), сделает точечный поиск и внесёт правки. Полный скан репозитория не
нужен.
