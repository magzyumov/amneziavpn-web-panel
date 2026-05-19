/**
 * stats.ts — чтение per-peer статистики из работающих AWG/WG контейнеров.
 *
 * `awg/wg show <iface> dump` отдаёт всё за один вызов — формат:
 *   line 0:  privkey<TAB>pubkey<TAB>port<TAB>fwmark     ← interface row
 *   line 1+: pubkey<TAB>psk<TAB>endpoint<TAB>allowed_ips<TAB>handshake<TAB>rx<TAB>tx<TAB>keepalive
 *
 * Все числа — десятичные. handshake=0 если ни разу не было.
 */

import { exec } from '../ssh.js';
import { assertContainerName } from '../shell.js';
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
