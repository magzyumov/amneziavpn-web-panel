#!/usr/bin/env bash
# Stop hook: run quality gates ONLY when matching files are dirty in the working
# tree. Silent no-op when nothing matches. On gate failure, emits
# decision:"block" JSON so Claude sees the gate output as feedback.
#
# Project has no test runner — the gate is `npm run typecheck` per package:
#   - backend/src/**   → cd backend  && npm run typecheck
#   - frontend/src/**  → cd frontend && npm run typecheck
#
# Node may not be installed on the host (it runs inside containers). If a local
# `npx tsc` is unavailable we fall back to typechecking inside the running
# backend container; for the frontend we skip with a note rather than block.

set -uo pipefail

# Drain stdin (Stop hook receives a JSON payload we don't need)
cat >/dev/null 2>&1 || true

# Repo root = two levels up from this script (.claude/hooks/ -> repo)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 0

CHANGED="$(git status --porcelain 2>/dev/null | awk '{print $NF}')"

NEED_BACKEND=0
NEED_FRONTEND=0
printf '%s\n' "$CHANGED" | grep -qE '^backend/src/'  && NEED_BACKEND=1
printf '%s\n' "$CHANGED" | grep -qE '^frontend/src/' && NEED_FRONTEND=1

if [ "$NEED_BACKEND" -eq 0 ] && [ "$NEED_FRONTEND" -eq 0 ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# typecheck <package-dir> <out-log> <out-rc>
typecheck() {
  local dir="$1" log="$2" rc="$3"
  if command -v npx >/dev/null 2>&1; then
    ( cd "$dir" && npx --no-install tsc --noEmit ) > "$log" 2>&1
    echo $? > "$rc"
  elif [ "$dir" = "backend" ] && command -v docker >/dev/null 2>&1 \
       && docker ps --format '{{.Names}}' | grep -q '^amnezia-panel-backend$'; then
    # Host has no node — typecheck the host sources inside the backend container.
    docker cp backend/src amnezia-panel-backend:/app/ >/dev/null 2>&1
    docker exec amnezia-panel-backend sh -c 'cd /app && npx tsc --noEmit' > "$log" 2>&1
    echo $? > "$rc"
  else
    echo "skipped: no local node/npx and no container fallback for $dir" > "$log"
    echo 0 > "$rc"
  fi
}

[ "$NEED_BACKEND" -eq 1 ]  && typecheck backend  "$TMP/be.log" "$TMP/be.rc"
[ "$NEED_FRONTEND" -eq 1 ] && typecheck frontend "$TMP/fe.log" "$TMP/fe.rc"

BE_RC=0; FE_RC=0
[ "$NEED_BACKEND" -eq 1 ]  && BE_RC="$(cat "$TMP/be.rc")"
[ "$NEED_FRONTEND" -eq 1 ] && FE_RC="$(cat "$TMP/fe.rc")"

if [ "$BE_RC" -eq 0 ] && [ "$FE_RC" -eq 0 ]; then
  exit 0
fi

REASON=""
if [ "$NEED_BACKEND" -eq 1 ] && [ "$BE_RC" -ne 0 ]; then
  REASON+=$'\n--- backend typecheck FAILED (exit '"$BE_RC"$') ---\n'
  REASON+="$(tail -200 "$TMP/be.log")"
fi
if [ "$NEED_FRONTEND" -eq 1 ] && [ "$FE_RC" -ne 0 ]; then
  REASON+=$'\n--- frontend typecheck FAILED (exit '"$FE_RC"$') ---\n'
  REASON+="$(tail -200 "$TMP/fe.log")"
fi

if command -v jq >/dev/null 2>&1; then
  jq -Rn --arg reason "$REASON" '{decision: "block", reason: $reason}'
else
  # Minimal JSON escaping fallback if jq is missing.
  ESCAPED="$(printf '%s' "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
  printf '{"decision":"block","reason":"%s"}\n' "$ESCAPED"
fi
exit 0
