/**
 * stats.ts — чтение per-peer статистики из работающих AWG/WG контейнеров.
 *
 * `awg/wg show <iface> dump` отдаёт всё за один вызов — формат:
 *   line 0:  privkey<TAB>pubkey<TAB>port<TAB>fwmark     ← interface row
 *   line 1+: pubkey<TAB>psk<TAB>endpoint<TAB>allowed_ips<TAB>handshake<TAB>rx<TAB>tx<TAB>keepalive
 *
 * Все числа — десятичные. handshake=0 если ни разу не было.
 */

import { exec, execSudo } from '../ssh.js';
import { assertContainerName } from '../shell.js';
import { readContainerFile } from './common.js';
import type { Server } from '../../types.js';

export interface PeerStats {
  pubkey: string;
  rxBytes: number;
  txBytes: number;
  lastHandshake: number;  // unix seconds, 0 если ни разу
  endpoint: string | null;
}

// AWG/WG: контейнер `amnezia-awg2` использует awg0, `amnezia-wireguard` — wg0.
// Утилита внутри контейнера — `awg` или `wg` соответственно.
export async function readAwgWgPeerStats(
  server: Server,
  containerName: string,
  tool: 'awg' | 'wg',
  iface: string,
): Promise<PeerStats[]> {
  assertContainerName(containerName);
  // Хотя `awg show <iface> dump` валиден для kernel-варианта, в Amnezia-контейнерах
  // используется userspace amneziawg-go, для которого работает та же команда.
  const res = await exec(server, `docker exec ${containerName} ${tool} show ${iface} dump 2>/dev/null`);
  if (res.code !== 0 || !res.stdout.trim()) return [];

  const lines = res.stdout.trim().split('\n');
  const peers: PeerStats[] = [];

  // первая строка — параметры интерфейса, пропускаем
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 7) continue;

    const pubkey   = cols[0];
    const endpoint = cols[2] === '(none)' ? null : cols[2];
    const handshake = parseInt(cols[4], 10);
    const rx       = parseInt(cols[5], 10);
    const tx       = parseInt(cols[6], 10);

    if (!pubkey || Number.isNaN(rx) || Number.isNaN(tx)) continue;

    peers.push({
      pubkey,
      rxBytes: rx,
      txBytes: tx,
      lastHandshake: Number.isNaN(handshake) ? 0 : handshake,
      endpoint,
    });
  }

  return peers;
}

// ─── Xray ────────────────────────────────────────────────────────────────────
//
// Xray-core отдаёт per-user счётчики через gRPC StatsService на api inbound
// (мы поднимаем его на 127.0.0.1:10085 в configure-скрипте). Конфиг должен
// содержать stats: {}, api с tag "api", policy.levels.0.statsUser{Up,Down}link
// и routing rule "inboundTag=[api] → outboundTag=api". Без этого CLI вернёт
// connection refused — это нормальный случай для протоколов, поставленных
// до того как мы добавили stats в шаблон (см. enable-stats endpoint).
//
// CLI отдаёт JSON вида:
//   { "stat": [
//       { "name": "user>>>UUID>>>traffic>>>uplink",   "value": "12345" },
//       { "name": "user>>>UUID>>>traffic>>>downlink", "value": "67890" }
//   ]}
// "user" — это поле email из конфига inbound, мы пишем туда UUID при создании.

interface XrayStatRow { name: string; value: string }
interface XrayStatsResponse { stat?: XrayStatRow[] }

export async function readXrayPeerStats(server: Server, containerName: string): Promise<PeerStats[]> {
  assertContainerName(containerName);
  const cmd = `docker exec ${containerName} xray api stats --server=127.0.0.1:10085 --pattern "user>>>" 2>/dev/null`;
  const res = await exec(server, cmd);
  if (res.code !== 0 || !res.stdout.trim()) return [];

  let parsed: XrayStatsResponse;
  try { parsed = JSON.parse(res.stdout); }
  catch { return []; }
  if (!parsed.stat?.length) return [];

  // Группируем uplink/downlink по email (= UUID).
  const byUser = new Map<string, { rx: number; tx: number }>();
  for (const row of parsed.stat) {
    // name: "user>>>{email}>>>traffic>>>{uplink|downlink}"
    const m = row.name.match(/^user>>>([^>]+)>>>traffic>>>(uplink|downlink)$/);
    if (!m) continue;
    const email = m[1];
    const kind = m[2] as 'uplink' | 'downlink';
    const val = Number(row.value) || 0;

    const entry = byUser.get(email) ?? { rx: 0, tx: 0 };
    // С точки зрения сервера: uplink = клиент → интернет (это его tx),
    // downlink = интернет → клиент (его rx). Зеркалим для соответствия AWG/WG.
    if (kind === 'uplink')   entry.tx = val;
    else                     entry.rx = val;
    byUser.set(email, entry);
  }

  const peers: PeerStats[] = [];
  for (const [email, e] of byUser) {
    peers.push({ pubkey: email, rxBytes: e.rx, txBytes: e.tx, lastHandshake: 0, endpoint: null });
  }
  return peers;
}

// Проверяем серверный конфиг Xray на наличие stats. Используется для UI
// (показать "Enable stats" кнопку) и воркером (skip опроса если не настроено).
export async function isXrayStatsEnabled(server: Server, containerName: string): Promise<boolean> {
  assertContainerName(containerName);
  try {
    const raw = await readContainerFile(server, containerName, '/opt/amnezia/xray/server.json');
    if (!raw) return false;
    const json = JSON.parse(raw);
    return !!json?.stats && Array.isArray(json?.api?.services) && json.api.services.includes('StatsService');
  } catch { return false; }
}

// Включает stats на существующем Xray-контейнере: дописывает блоки в server.json
// через jq внутри контейнера, добавляет email/level=0 каждому клиенту,
// перезапускает контейнер. Идемпотентна — повторный вызов не ломает конфиг.
export async function enableXrayStats(server: Server, containerName: string): Promise<void> {
  assertContainerName(containerName);

  // jq-скрипт, обновляющий конфиг: добавляет stats/api/policy/routing,
  // вставляет api inbound в начало, выставляет vless-in tag + email/level для
  // существующих клиентов. Идемпотентен — переписывает поля целиком.
  const jqScript = `
    .stats = {} |
    .api = { tag: "api", services: ["StatsService"] } |
    .policy = (.policy // {}) |
      .policy.levels = ((.policy.levels // {}) + { "0": { statsUserUplink: true, statsUserDownlink: true } }) |
      .policy.system = ((.policy.system // {}) + { statsInboundUplink: true, statsInboundDownlink: true }) |
    .routing = (.routing // {}) |
      .routing.rules = (((.routing.rules // []) | map(select(.inboundTag != ["api"]))) + [{ type: "field", inboundTag: ["api"], outboundTag: "api" }]) |
    .inbounds = (
      [{ tag: "api", port: 10085, listen: "127.0.0.1", protocol: "dokodemo-door", settings: { address: "127.0.0.1" } }]
      + ((.inbounds // []) | map(
          if .protocol == "vless" then
            (.tag = (.tag // "vless-in")) |
            (.settings.clients |= map(. + { email: (.email // .id), level: (.level // 0) }))
          else . end
        ) | map(select(.tag != "api")))
    ) |
    .outbounds = (
      ((.outbounds // []) | map(select(.tag != "api")))
      + [{ protocol: "blackhole", tag: "api" }]
    )
  `.trim().replace(/\s+/g, ' ');

  // Запускаем jq внутри контейнера через docker exec. jq уже есть в alpine-based
  // образах amnezia-xray; если нет — добавим apk add.
  const installJq = `docker exec ${containerName} sh -c 'command -v jq >/dev/null 2>&1 || apk add --no-cache jq >/dev/null 2>&1'`;
  await execSudo(server, installJq);

  const patchCmd = `docker exec ${containerName} sh -c "cd /opt/amnezia/xray && jq '${jqScript.replace(/"/g, '\\"').replace(/'/g, "'\\''")}' server.json > server.json.new && mv server.json.new server.json"`;
  const patchRes = await execSudo(server, patchCmd);
  if (patchRes.code !== 0) {
    throw new Error(`Failed to patch xray server.json with jq: ${patchRes.stderr || patchRes.stdout}`);
  }

  const restartRes = await execSudo(server, `docker restart ${containerName}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart xray container: ${restartRes.stderr || restartRes.stdout}`);
  }
}
