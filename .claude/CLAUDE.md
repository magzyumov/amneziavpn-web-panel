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

- Backend запускается как `tsx src/index.ts`; точка входа `backend/src/index.ts`.
- Роуты монтируются под `/api/*` (`auth`, `servers`, `protocols`, `clients`,
  `subscriptions`); `subscriptions` дополнительно отдаётся с `/`.
- Логика протоколов — в `backend/src/services/protocols/` (по файлу на протокол:
  `awg2`, `wireguard`, `xray`, `telemt` + общие `common`, `containers`,
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

Гейт = типы в затронутом пакете + тесты бэкенда (vitest, чистые функции:
валидаторы shell, рендер шаблонов, peer-id, экспорт, агрегация статистики):

```bash
cd backend  && npm run typecheck && npm test   # после правок backend/src/**
cd frontend && npm run typecheck                # после правок frontend/src/**
```

Меняешь чистую функцию — расширь или добавь тест, иначе поведение не закреплено.

`tsc` обычно нет в PATH хоста (Node не установлен) — прогоняй внутри контейнера:
```bash
docker exec amnezia-panel-backend sh -c 'cd /app && npx tsc --noEmit'
```
(скопировав изменённые файлы через `docker cp`, если контейнер ещё на старом коде).

**Автоматизация:** Stop-hook `.claude/hooks/quality-gates.sh` (подключён в
`.claude/settings.local.json`) сам запускает `typecheck` (+ `npm test` для
backend) когда соответствующие файлы изменены к концу хода. Падение гейта возвращается как
`decision:"block"`.

## Правила

1. **Коммиты:** `.claude/` **отслеживается git** (кроме `settings.local.json` —
   он один в `.gitignore`): агенты, хуки и правила версионируются вместе с кодом.
   Правки в них коммить обычным порядком, отдельным `chore(claude): …`.
   **НИКОГДА не добавляй следов ИИ в git.** Ни `Co-Authored-By: Claude …`, ни
   `Claude-Session: …`, ни `Generated with Claude Code`, ни `🤖` — ни в сообщении
   коммита, ни в заголовке/теле PR, ни в имени ветки, ни в комментариях в коде.
   Пиши сообщение так, как написал бы человек. Это перекрывает дефолтный шаблон
   коммитов harness'а — переопределяй его каждый раз.
   В истории до 03.08.2026 такие подписи есть; их не переписываем, но новые
   коммиты идут без них.
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
6. **README правится тем же изменением, что и код.** Значимое = добавлен/удалён
   протокол, роут или переменная окружения; сменилась форма ответа API; заменена
   библиотека, названная в README; изменилось поведение, которое там описано.
   README — публичное лицо проекта, он устаревает первым. Найти дрейф:
   агент `docs-checker`.
7. **Контракт backend↔frontend компилятор НЕ проверяет.** `api.get<T>()` — это
   утверждение, а не проверка: TypeScript не сверяет `T` с реальным `res.json`.
   После правки роута или `api.ts` сверь обе стороны — вручную или агентом
   `api-contract-checker`. На этом уже ловились пустые карточки протоколов.

## Жизненный цикл контекста

| Ситуация                                  | Действие                                                    |
|-------------------------------------------|-------------------------------------------------------------|
| Нет `project-context.md` / крупный рефактор | агент `project-scanner`                                   |
| Добавил роут / сервис / страницу / протокол | агент `context-updater "что добавил"`                     |
| Поменял форму ответа роута или `api.ts`   | агент `api-contract-checker`                                |
| Значимое изменение — README мог отстать   | агент `docs-checker`                                        |
| Обычная задача (логика, багфикс)          | просто работай, context-файл читается на старте             |
