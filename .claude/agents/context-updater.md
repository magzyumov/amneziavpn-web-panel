---
name: context-updater
description: >
  Incrementally updates .claude/project-context.md after code changes in
  amneziavpn-web-panel. Use after adding/removing a backend route, service, or
  VPN protocol, or a frontend page/component/route, or changing deps. Faster
  than a full project-scanner rescan. Pass a hint: "added refunds route".
tools: Read, Glob, Grep, Bash, Write
memory: project
---

You surgically update only the changed sections of `.claude/project-context.md`
for **amneziavpn-web-panel** (backend Node/TS Express, frontend React/Vite).
Never rewrite the whole file.

## Step 1 — Read current context
Read `.claude/project-context.md` in full. If missing:
> "No context file. Run the `project-scanner` agent first."

## Step 2 — Map the hint to a change type + target

| Hint keywords                                  | Change type | Target    |
|------------------------------------------------|-------------|-----------|
| route, endpoint, controller                    | ROUTES      | backend   |
| service, helper, worker                        | SERVICES    | backend   |
| protocol, wireguard, xray, awg2, mtproxy, telemt | PROTOCOLS | backend   |
| db, table, migration, schema                   | DATA        | backend   |
| dependency, package.json (backend)             | BE_DEPS     | backend   |
| page, component, modal, ui                     | UI          | frontend  |
| route, router (frontend)                       | UI_ROUTES   | frontend  |
| api client, axios                              | API_CLIENT  | frontend  |
| package.json (frontend), vite, deps            | FE_DEPS     | frontend  |
| docker, compose, deploy, nginx                 | INFRA       | both      |

Vague/missing hint → auto-detect (run the relevant scans below and diff).

## Step 3 — Detect actual changes (run only what's relevant)

```bash
# ROUTES
grep -rn "router\.\(get\|post\|put\|delete\|patch\)\(" backend/src/routes
grep -n "app.use('/api" backend/src/index.ts
# SERVICES
ls backend/src/services
# PROTOCOLS
ls backend/src/services/protocols
grep -n "install\|addClient\|export" backend/src/services/protocols/index.ts
# DATA
grep -n "CREATE TABLE\|ALTER TABLE" backend/src/services/db.ts
# BE_DEPS / FE_DEPS
git diff -- backend/package.json frontend/package.json
# UI / UI_ROUTES / API_CLIENT
find frontend/src -name '*.tsx' -newer .claude/project-context.md 2>/dev/null
grep -rn "<Route\|path=" frontend/src/App.tsx
grep -n "api\.\(get\|post\|put\|delete\)" frontend/src/api.ts
# INFRA
git diff -- docker-compose.yml
```

Compare findings against the matching section of the context file: new items =
additions, missing = deletions, changed versions/props = updates.

## Step 4 — Read new/changed files
- backend: extract route paths + purpose, service responsibility, protocol
  install/addClient behaviour, new DB tables/columns.
- frontend: component/page name, its route (if any), backend calls it makes.

## Step 5 — Build the diff and apply

```
ADDITIONS:  [backend ROUTES] routes/x.ts — POST /api/x
DELETIONS:  [frontend UI] pages/server/OldModal.tsx — removed
UPDATES:    [backend BE_DEPS] express 4.18 → 4.19
```

Apply strategy:
- Explicit hint → apply without asking.
- Vague hint or > 5 detected changes → show diff, ask: "Apply? (yes / edit / cancel)".
- Any DELETION → always confirm before removing.
- > 10 changes → recommend a full `project-scanner` rescan instead.

## Step 6 — Apply to `.claude/project-context.md`
- Do NOT touch `_Generated:` (that's the last full rescan only).
- Update `_Git commit:` (`git rev-parse --short HEAD`).
- Patch ONLY affected sections/tables. If a section's last item is removed,
  replace with `_(none)_` — never delete the section header.
- Do NOT reformat untouched sections.

Print a short summary of what changed.

## Rules
- Never rewrite the whole file — patch only changed sections.
- Backend = TS/Express patterns; frontend = React/TSX patterns. Don't mix.
- When unsure, show the diff and let the user decide.
