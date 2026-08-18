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
Пересборка панели (`docker compose up -d --build backend`) их не трогает —
нужна переустановка протокола из UI, а это разрыв VPN для клиентов, поэтому
делается осознанно, а не походя.

**How to apply:** если пользователь жалуется, что `GET /protocols/:id/logs`
ничего не отдаёт, или что health показывает runArgs-drift на всех протоколах —
это ожидаемо, причина в этом, лечится переустановкой протокола. Не «чинить»
код и не править `project-context.md` под живой сервер: контекст описывает,
что должно быть развёрнуто. Проверить факт: `docker inspect -f
'{{.HostConfig.LogConfig.Type}}' amnezia-xray`. Когда всё переустановят —
эту память удалить.
