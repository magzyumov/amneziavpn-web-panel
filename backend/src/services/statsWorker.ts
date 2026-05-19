/**
 * statsWorker.ts — фоновый воркер сбора per-client статистики.
 *
 * Раз в STATS_POLL_INTERVAL_MS опрашивает все запущенные AWG/WG протоколы:
 *   1. SELECT'ом группирует протоколы по server_id (одно SSH-соединение на сервер)
 *   2. Для каждого AWG/WG контейнера читает `<tool> show <iface> dump`
 *   3. Мапит pubkey → client_id через clients.peer_id
 *   4. INSERT'ит снимок в client_stats
 *
 * Xray не поддерживается на текущей итерации — его stats API не включён
 * в дефолтном конфиге контейнера (см. README раздел про статистику).
 *
 * Retention: при старте дёргает purgeOldStats — удаляет записи старше
 * STATS_RETENTION_DAYS дней. Re-run каждые 6ч.
 */

import { query, run } from './db.js';
import { readAwgWgPeerStats } from './protocols/index.js';
import { logger } from './logger.js';
import type { Server, Protocol } from '../types.js';

const POLL_INTERVAL_MS    = Number(process.env.STATS_POLL_INTERVAL_MS)    || 60_000;
const RETENTION_DAYS      = Number(process.env.STATS_RETENTION_DAYS)      || 30;
const PURGE_INTERVAL_MS   = 6 * 60 * 60 * 1000;

interface ProtocolWithServer extends Protocol {
  // server columns (приджойнены)
  s_id: string;
  s_host: string;
  s_port: number;
  s_username: string;
  s_auth_type: 'password' | 'key';
  s_password: string | null;
  s_private_key: string | null;
}

interface ClientRow {
  id: string;
  peer_id: string;
}

const tickerHandle: { poll: NodeJS.Timeout | null; purge: NodeJS.Timeout | null } = { poll: null, purge: null };

export function startStatsWorker(): void {
  // Первый snapshot — не сразу, дать backend'у прожить пару секунд после listen
  setTimeout(() => { void pollOnce(); }, 5_000);

  tickerHandle.poll = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  tickerHandle.purge = setInterval(purgeOldStats, PURGE_INTERVAL_MS);
  // Сразу подчистим старые
  setTimeout(purgeOldStats, 10_000);

  logger.info({ intervalMs: POLL_INTERVAL_MS, retentionDays: RETENTION_DAYS }, 'stats worker started');
}

export function stopStatsWorker(): void {
  if (tickerHandle.poll)  { clearInterval(tickerHandle.poll);  tickerHandle.poll  = null; }
  if (tickerHandle.purge) { clearInterval(tickerHandle.purge); tickerHandle.purge = null; }
}

async function pollOnce(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Берём protocols + server columns одним запросом.
  // Только running AWG/WG — Xray тут не обрабатываем.
  const rows = query<ProtocolWithServer>(`
    SELECT
      p.id, p.server_id, p.type, p.name, p.container_name, p.port, p.config, p.status,
      s.id AS s_id, s.host AS s_host, s.port AS s_port, s.username AS s_username,
      s.auth_type AS s_auth_type, s.password AS s_password, s.private_key AS s_private_key
    FROM protocols p
    JOIN servers s ON s.id = p.server_id
    WHERE p.status = 'running' AND p.type IN ('awg2', 'wireguard')
  `);

  for (const row of rows) {
    const server: Server = {
      id: row.s_id, name: '', host: row.s_host, port: row.s_port, username: row.s_username,
      auth_type: row.s_auth_type, password: row.s_password, private_key: row.s_private_key,
    };
    const tool: 'awg' | 'wg' = row.type === 'awg2' ? 'awg' : 'wg';
    const iface = row.type === 'awg2' ? 'awg0' : 'wg0';

    let peers;
    try {
      peers = await readAwgWgPeerStats(server, row.container_name, tool, iface);
    } catch (e) {
      logger.debug({ err: e, protocol: row.id, container: row.container_name }, 'stats poll failed');
      continue;
    }
    if (!peers.length) continue;

    // Один SELECT клиентов под этот протокол с peer_id IS NOT NULL
    const clients = query<ClientRow>(
      "SELECT id, peer_id FROM clients WHERE protocol_id = ? AND peer_id IS NOT NULL",
      [row.id],
    );
    if (!clients.length) continue;

    const pkToId = new Map<string, string>();
    for (const c of clients) pkToId.set(c.peer_id, c.id);

    let inserted = 0;
    for (const peer of peers) {
      const clientId = pkToId.get(peer.pubkey);
      if (!clientId) continue;
      run(
        'INSERT OR REPLACE INTO client_stats (client_id, ts, rx_bytes, tx_bytes, last_handshake) VALUES (?, ?, ?, ?, ?)',
        [clientId, now, peer.rxBytes, peer.txBytes, peer.lastHandshake || null],
      );
      inserted++;
    }
    if (inserted) logger.debug({ protocol: row.id, inserted }, 'stats snapshot');
  }
}

function purgeOldStats(): void {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 24 * 60 * 60;
  try {
    run('DELETE FROM client_stats WHERE ts < ?', [cutoff]);
  } catch (e) {
    logger.error({ err: e }, 'stats purge failed');
  }
}
