---
name: project-log-driver-reinstall-pending
description: Прод-контейнеры протоколов всё ещё на --log-driver none; новые run-args (json-file) применятся только при переустановке протокола
metadata:
  type: project
---

С коммита `0a222ba` (18.08.2026) run-args всех протоколов задают
`--log-driver json-file --log-opt max-size=10m --log-opt max-file=3` вместо
`--log-driver none`. На боевом VPS на 18.08.2026 контейнеры `amnezia-xray`,
`amnezia-awg2`, `amnezia-dns` всё ещё подняты со старым `none` — код изменился,
рантайм нет.

**Why:** `docker run` применяет log-опции только при создании контейнера.
Пересборка панели (`docker compose up -d --build backend`) их не трогает.
Раньше единственным способом была переустановка протокола (разрыв VPN и новые
ключи у клиентов), поэтому её откладывали. С 25.08.2026 есть `POST
/protocols/:id/upgrade` (`upgradeProtocolContainer`, кнопка на бейдже «⟳
устарел»): пересоздаёт контейнер на текущих run-args, сохраняя конфиги, ключи
и клиентов, — это и есть штатное лечение.

**How to apply:** если пользователь жалуется, что `GET /protocols/:id/logs`
ничего не отдаёт, или что health показывает runArgs-drift на всех протоколах —
это ожидаемо, причина в этом; предлагай кнопку upgrade, а не переустановку и не
правки кода. И не подгоняй `project-context.md` под живой сервер: контекст
описывает, что должно быть развёрнуто. Проверить факт: `docker inspect -f
'{{.HostConfig.LogConfig.Type}}' amnezia-xray`. Когда все контейнеры проапгрейдят —
эту память удалить.
