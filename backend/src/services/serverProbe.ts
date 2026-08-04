// Опрос состояния VPS: аптайм, нагрузка, память, диск и наличие AmneziaDNS.
//
// Единственное место в панели, которое ходит по SSH ради дашборда, и делает это
// ТОЛЬКО по явной команде администратора. Автоматически — никогда: заход на
// главную не должен превращаться в веер подключений ко всем серверам, а сама
// главная не должна ждать самого медленного из них.
//
// Результат кэшируется в таблице servers, дашборд читает его оттуда вместе с
// возрастом замера.
import { exec } from './ssh.js';
import { isDnsRunning } from './protocols/index.js';
import { query, run } from './db.js';
import { logger } from './logger.js';
import type { Server } from '../types.js';

export interface HostMetrics {
  uptimeSec: number | null;
  load1: number | null;
  memTotalMb: number | null;
  memUsedMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
}

// Разбор вывода одной командой. Формат — KEY|значения, по строке на метрику:
// так парсер не зависит от локали и от порядка полей в `free`/`df`.
export function parseHostMetrics(stdout: string): HostMetrics {
  const fields = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const [key, ...rest] = line.trim().split('|');
    if (key) fields.set(key, rest);
  }

  // Берём первый токен: /proc/uptime отдаёт два числа через пробел, и хотя
  // команда режет его через cut, полагаться на это в парсере незачем — на
  // busybox-хостах поведение утилит отличается.
  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const first = v.trim().split(/\s+/)[0];
    if (!first) return null;
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  };

  const mem = fields.get('MEM') ?? [];
  const disk = fields.get('DISK') ?? [];
  return {
    uptimeSec: num(fields.get('UPTIME')?.[0]) !== null ? Math.floor(num(fields.get('UPTIME')![0])!) : null,
    load1: num(fields.get('LOAD')?.[0]),
    memTotalMb: num(mem[0]),
    memUsedMb: num(mem[1]),
    diskTotalMb: num(disk[0]),
    diskFreeMb: num(disk[1]),
  };
}

// /proc и POSIX-режим df (-P) — чтобы вывод не переносился на вторую строку у
// длинных имён устройств. Всё в одной команде: одно SSH-соединение на сервер.
const PROBE_CMD = [
  `echo "UPTIME|$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
  `echo "LOAD|$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
  `echo "MEM|$(free -m 2>/dev/null | awk '/^Mem:/{print $2"|"$3}')"`,
  `echo "DISK|$(df -Pm / 2>/dev/null | awk 'NR==2{print $2"|"$4}')"`,
].join('; ');

export async function probeServer(server: Server): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const res = await exec(server, PROBE_CMD);
    const m = parseHostMetrics(res.stdout);
    const dns = await isDnsRunning(server);

    run(`UPDATE servers SET probed_at = ?, probe_error = NULL, dns_installed = ?,
         uptime_sec = ?, load1 = ?, mem_total_mb = ?, mem_used_mb = ?, disk_total_mb = ?, disk_free_mb = ?
         WHERE id = ?`,
      [now, dns ? 1 : 0, m.uptimeSec, m.load1, m.memTotalMb, m.memUsedMb, m.diskTotalMb, m.diskFreeMb, server.id]);
  } catch (e) {
    // Недоступный сервер — это результат опроса, а не сбой опроса: записываем
    // причину и идём дальше, иначе один мёртвый VPS ронял бы всю проверку.
    logger.warn({ err: e, server: server.id }, 'server probe failed');
    run('UPDATE servers SET probed_at = ?, probe_error = ? WHERE id = ?',
      [now, (e as Error).message.slice(0, 500), server.id]);
  }
}

export async function probeAllServers(): Promise<{ probed: number }> {
  const servers = query<Server>('SELECT * FROM servers');
  // Последовательно: серверов единицы, а параллельные SSH-хендшейки к разным
  // хостам ничего не выигрывают на фоне их собственной задержки.
  for (const s of servers) await probeServer(s);
  return { probed: servers.length };
}

// Кэш статуса AmneziaDNS обновляется и обычной проверкой со страницы сервера —
// чтобы дашборд знал о нём, не дожидаясь ручного опроса.
export function cacheDnsStatus(serverId: string, installed: boolean): void {
  run('UPDATE servers SET dns_installed = ? WHERE id = ?', [installed ? 1 : 0, serverId]);
}

// То же для дрейфа: его считает периодический health-запрос страницы сервера,
// и незачем считать его второй раз ради дашборда.
export function cacheDrift(protocolId: string, drift: { image: boolean; runArgs: boolean }): void {
  run('UPDATE protocols SET drift_image = ?, drift_run_args = ?, drift_checked_at = ? WHERE id = ?',
    [drift.image ? 1 : 0, drift.runArgs ? 1 : 0, Math.floor(Date.now() / 1000), protocolId]);
}
