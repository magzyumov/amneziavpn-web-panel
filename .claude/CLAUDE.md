# Claude Agent Instructions — amneziavpn-web-panel

Web-панель управления AmneziaVPN: по SSH ходит на удалённые VPS и управляет
Docker-контейнерами VPN-протоколов. **Backend** — Node + TypeScript (Express),
**frontend** — React + Vite. Деплой — Docker Compose. Это НЕ Kotlin/Gradle
монорепо: игнорируй любые упоминания `:api/:app/:ui`, Spring, Kafka, Istio,
OpenAPI, Gradle/detekt/Jacoco, SocratiCode — этого здесь нет.

## Старт задачи

1. Если есть `.claude/project-context.md` — прочитай его как основной источник
   правды о структуре, стеке и инвентаре модулей. Если нет — можно
   сгенерировать через агента `project-scanner` (`.claude/agents/project-scanner.md`),
   но это не обязательно для мелких задач.
2. Для поиска используй обычные инструменты (Grep/Glob/Read/Explore). Кодовая
   база небольшая — точечный grep по имени роута/сервиса/компонента быстрее
   полного скана. Не сканируй весь репозиторий ради структуры — она в context-файле.

## Раскладка проекта

| Каталог     | Стек                              | Роль                                              |
|-------------|-----------------------------------|---------------------------------------------------|
| `backend/`  | Node 20 + TS (ESM), Express 4     | API-сервер; SSH к VPS, управление Docker, sqlite  |
| `frontend/` | React 18 + Vite + TS              | SPA-панель, общается с backend через axios (`api.ts`) |
| `data/`     | —                                 | sqlite-БД панели (`panel.db`), монтируется в backend |
| `server_scripts/` | bash                        | вспомогательные скрипты для серверов              |

- Backend запускается как `tsx src/index.ts`; точка входа `backend/src/index.ts`.
- Роуты монтируются под `/api/*` (`auth`, `servers`, `protocols`, `clients`,
  `subscriptions`); `subscriptions` дополнительно отдаётся с `/`.
- Логика протоколов — в `backend/src/services/protocols/` (по файлу на протокол:
  `awg2`, `wireguard`, `xray`, `mtproxy`, `telemt` + общие `common`, `containers`,
  `dockerfiles`, `stats`, диспетчер `index`).

## Деплой и среда (ВАЖНО)

- **Этот рабочий каталог запущен НА боевом VPS.** Запущенные контейнеры
  (`amnezia-panel-backend`, `amnezia-panel-frontend`, `amnezia-xray`,
  `amnezia-wireguard`, …) — это прод. Действуй осторожно.
- **Исходник НЕ смонтирован** в контейнеры — образы собираются копией из
  `./backend` / `./frontend` (в backend монтируется только `./data:/data`).
  Правки `.ts` на хосте НЕ влияют на работающие контейнеры, пока не пересоберёшь.
- **🚀 ОБЯЗАТЕЛЬНО: после всех правок и проверок (typecheck) — задеплой.**
  Правка в рабочем дереве ≠ рабочая система. Завершай задачу пересборкой
  затронутого сервиса и проверкой, что он поднялся:
  ```bash
  docker compose up -d --build backend     # и/или frontend — что менял
  docker ps | grep amnezia-panel            # контейнер healthy?
  docker exec amnezia-panel-backend wget -qO- http://localhost:3001/api/health
  ```
  Не считай задачу выполненной, пока изменения не задеплоены на боевую систему
  (или пока пользователь явно не попросил отложить деплой).
- **Отладка 500-х:** маршруты не оборачивают хендлеры в try/catch; брошенные
  ошибки глобальный обработчик (`backend/src/index.ts`) логирует целиком, но
  клиенту отдаёт обезличенное `{ error: 'Internal server error' }`. Реальный
  текст — в логах:
  ```bash
  docker logs amnezia-panel-backend 2>&1 | grep -A20 "Unhandled error"
  ```
- VPN-протоколы зависят от среды VPS: WireGuard использует kernel-модуль
  `wireguard` (alpine + wireguard-tools), AWG2 — userspace amneziawg-go.

## Quality gate

Тестов в проекте нет — гейт = проверка типов в затронутом пакете:

```bash
cd backend  && npm run typecheck      # после правок backend/src/**
cd frontend && npm run typecheck      # после правок frontend/src/**
```

`tsc` обычно нет в PATH хоста (Node не установлен) — прогоняй внутри контейнера:
```bash
docker exec amnezia-panel-backend sh -c 'cd /app && npx tsc --noEmit'
```
(скопировав изменённые файлы через `docker cp`, если контейнер ещё на старом коде).

**Автоматизация:** Stop-hook `.claude/hooks/quality-gates.sh` (подключён в
`.claude/settings.local.json`) сам запускает `typecheck` для backend/frontend,
когда соответствующие файлы изменены к концу хода. Падение гейта возвращается как
`decision:"block"`.

## Правила

1. **Коммиты:** `.claude/` в `.gitignore` — это локальные настройки, не коммить их.
   В коммитах этого репозитория принят `Co-Authored-By: Claude …` (следуй
   существующей конвенции git-истории).
2. **Не сканируй весь репозиторий** ради понимания структуры — используй
   context-файл или точечный grep.
3. **Безопасность ввода в shell:** данные, идущие в SSH/Docker-команды, валидируй
   через `backend/src/services/shell.ts` (`assertContainerName`, `assertPort`,
   `assertDomain`, `shInt`). Не интерполируй сырой пользовательский ввод в команды.
4. **Файлы на VPS** пиши/читай через хелперы `backend/src/services/protocols/common.ts`
   (`writeRemoteFile`/`readRemoteFile`/`readContainerFile`) — они решают вопросы
   экранирования через base64.
5. **Шаблоны Dockerfile/скриптов** в `dockerfiles.ts` — это JS template literals;
   следи за экранированием (`\\n`, `\\` continuation) — баги тут ломают `docker build`.

## Жизненный цикл контекста

| Ситуация                                  | Действие                                                    |
|-------------------------------------------|-------------------------------------------------------------|
| Нет `project-context.md` / крупный рефактор | агент `project-scanner`                                   |
| Добавил роут / сервис / страницу / протокол | агент `context-updater "что добавил"`                     |
| Обычная задача (логика, багфикс)          | просто работай, context-файл читается на старте             |
