// Сводка для главной страницы. Всё считается из базы — ни одного SSH-вызова:
// дашборд открывают чаще всего, и он не должен зависеть от доступности VPS.
// Живость сервера видна по свежести последнего успешного опроса воркером
// статистики (protocols.last_poll_at), а не по отдельной проверке связи.
//
// Трафик берётся из тех же накопительных снимков client_stats, что и вкладка
// статистики, поэтому цифры на дашборде и в карточке клиента сходятся.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne } from './db.js';
import { dayStartSec } from './limits.js';
import type { ProtocolType } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/panel.db');
const RETENTION_DAYS = Number(process.env.STATS_RETENTION_DAYS) || 30;

// Снимки прореживаются до одного на час прямо в SQL: при минутном интервале и
// 30-дневном хранении сырых строк на клиента набирается больше сорока тысяч, а
// для суточных сумм такая точность не нужна. Теряется только трафик между
// последним снимком часа и рестартом контейнера внутри того же часа — та же
// погрешность, что уже заложена в agregation вкладки статистики.
const HOUR = 3600;

export interface HourlySample {
  client_id: string;
  ts: number;
  rx_bytes: number;
  tx_bytes: number;
}

export interface DayBucket { day: string; rx: number; tx: number }

// Приращение накопительного счётчика. Отрицательное = счётчик обнулился
// (рестарт контейнера либо возврат приостановленного пира) — клампим в 0.
function delta(prev: number, next: number): number {
  return next >= prev ? next - prev : 0;
}

// Ключ суток в локальной зоне процесса — той же, по которой считается суточный
// лимит трафика (см. limits.ts). Часовой пояс задаётся переменной TZ.
export function dayKey(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Трафик по суткам. rows должны идти по возрастанию ts внутри каждого клиента;
// приращение относится к суткам ПОЗДНЕГО снимка пары.
export function trafficByDay(rows: readonly HourlySample[]): DayBucket[] {
  const byDay = new Map<string, { rx: number; tx: number }>();
  const prev = new Map<string, HourlySample>();

  for (const row of rows) {
    const before = prev.get(row.client_id);
    prev.set(row.client_id, row);
    if (!before) continue; // первый снимок клиента — только база отсчёта

    const key = dayKey(row.ts);
    const bucket = byDay.get(key) ?? { rx: 0, tx: 0 };
    bucket.rx += delta(before.rx_bytes, row.rx_bytes);
    bucket.tx += delta(before.tx_bytes, row.tx_bytes);
    byDay.set(key, bucket);
  }

  return [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// Суммарный трафик за весь переданный период, по клиентам.
export function trafficByClient(rows: readonly HourlySample[]): Map<string, { rx: number; tx: number }> {
  const totals = new Map<string, { rx: number; tx: number }>();
  const prev = new Map<string, HourlySample>();

  for (const row of rows) {
    const before = prev.get(row.client_id);
    prev.set(row.client_id, row);
    if (!before) continue;

    const t = totals.get(row.client_id) ?? { rx: 0, tx: 0 };
    t.rx += delta(before.rx_bytes, row.rx_bytes);
    t.tx += delta(before.tx_bytes, row.tx_bytes);
    totals.set(row.client_id, t);
  }
  return totals;
}

// Заполняет пропущенные сутки нулями: без этого график «схлопывает» дни без
// трафика и врёт про динамику.
export function fillMissingDays(buckets: readonly DayBucket[], days: number, nowSec: number): DayBucket[] {
  const byDay = new Map(buckets.map(b => [b.day, b]));
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(nowSec - i * 24 * HOUR);
    out.push(byDay.get(key) ?? { day: key, rx: 0, tx: 0 });
  }
  return out;
}

// Снимки за период, прореженные до одного в час. Прореживание делает SQLite:
// при MIN/MAX остальные колонки берутся из той же строки — это документированное
// поведение. Общая точка входа для сводки и для личной статистики пользователя,
// чтобы цифры считались одним способом.
export function hourlySamplesSince(sinceSec: number): HourlySample[] {
  return query<HourlySample>(`
    SELECT client_id, MAX(ts) AS ts, rx_bytes, tx_bytes
    FROM client_stats
    WHERE ts >= ?
    GROUP BY client_id, ts / ${HOUR}
    ORDER BY client_id ASC, ts ASC
  `, [sinceSec]);
}

// Трафик каждого клиента с указанного момента. Используется страницей «Мои
// клиенты»: пользователь видит расход по своим устройствам.
export function clientTrafficSince(sinceSec: number): Map<string, { rx: number; tx: number }> {
  return trafficByClient(hourlySamplesSince(sinceSec));
}

// Последнее рукопожатие каждого клиента — для отметки «онлайн».
export function lastHandshakes(): Map<string, number> {
  const rows = query<{ client_id: string; last_handshake: number | null }>(`
    SELECT client_id, MAX(ts) AS ts, last_handshake FROM client_stats GROUP BY client_id
  `);
  const out = new Map<string, number>();
  for (const r of rows) if (r.last_handshake) out.set(r.client_id, r.last_handshake);
  return out;
}

export function isOnline(lastHandshake: number | undefined, nowSec: number): boolean {
  return !!lastHandshake && nowSec - lastHandshake < ONLINE_WINDOW_SEC;
}

// ─── Сбор сводки ──────────────────────────────────────────────────────────────

const ONLINE_WINDOW_SEC = 180;   // как в статистике клиента: 3 минуты от handshake
const TRAFFIC_DAYS = 14;
const TOP_CLIENTS = 5;
const EXPIRING_SOON_SEC = 24 * HOUR;
// Опрос идёт раз в минуту; три пропуска подряд — уже повод показать протокол
// как «не отвечает», а не мигать на каждой сетевой икоте.
const STALE_POLL_SEC = 5 * 60;

// Метрики хоста и статус DNS приходят из ручного опроса (services/serverProbe.ts)
// и живут в базе. null = замера ещё не было — так и показываем, не выдумывая.
export interface ServerSummary {
  id: string; name: string; host: string;
  protocols: number; running: number;
  lastPollAt: number | null;
  stale: boolean;
  dnsInstalled: boolean | null;
  probedAt: number | null;
  probeError: string | null;
  uptimeSec: number | null;
  load1: number | null;
  memTotalMb: number | null;
  memUsedMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
}

export interface DashboardSummary {
  servers: ServerSummary[];
  protocols: { total: number; running: number; byType: Array<{ type: ProtocolType; count: number; clients: number }> };
  users: { total: number; admins: number; regular: number };
  clients: {
    total: number; online: number; suspended: number;
    withLimits: number; expiringSoon: number; orphaned: number;
    /** Уникальных клиентов с рукопожатием за текущие сутки. */
    activeToday: number;
  };
  // Протоколы, где что-то стоит починить. Всё считается по кэшу и по свежести
  // снимков — SSH здесь не происходит.
  issues: {
    /** Собран не из текущего Dockerfile или запущен со старыми аргументами. */
    drifted: Array<{ id: string; serverId: string; serverName: string; type: ProtocolType; image: boolean; runArgs: boolean }>;
    /** Запущен, клиенты есть, а снимков статистики нет — для Xray обычно значит выключенный stats API. */
    silent: Array<{ id: string; serverId: string; serverName: string; type: ProtocolType; clients: number }>;
  };
  storage: {
    dbBytes: number;
    statsRows: number;
    oldestSnapshotAt: number | null;
    retentionDays: number;
  };
  traffic: {
    today: { rx: number; tx: number };
    week: { rx: number; tx: number };
    daily: DayBucket[];
    topClients: Array<{ id: string; name: string; type: ProtocolType; owner: string | null; rx: number; tx: number }>;
  };
  subscriptions: number;
}

export function buildDashboard(nowSec: number = Math.floor(Date.now() / 1000)): DashboardSummary {
  const servers = query<{
    id: string; name: string; host: string;
    dns_installed: number | null; probed_at: number | null; probe_error: string | null;
    uptime_sec: number | null; load1: number | null;
    mem_total_mb: number | null; mem_used_mb: number | null;
    disk_total_mb: number | null; disk_free_mb: number | null;
  }>(`
    SELECT id, name, host, dns_installed, probed_at, probe_error,
           uptime_sec, load1, mem_total_mb, mem_used_mb, disk_total_mb, disk_free_mb
    FROM servers ORDER BY name
  `);

  const protocolRows = query<{
    id: string; server_id: string; type: ProtocolType; status: string; last_poll_at: number | null;
    drift_image: number | null; drift_run_args: number | null; clients: number;
  }>(`
    SELECT p.id, p.server_id, p.type, p.status, p.last_poll_at, p.drift_image, p.drift_run_args,
           (SELECT COUNT(*) FROM clients c WHERE c.protocol_id = p.id) AS clients
    FROM protocols p
  `);

  const serverSummary: ServerSummary[] = servers.map(s => {
    const own = protocolRows.filter(p => p.server_id === s.id);
    const polls = own.map(p => p.last_poll_at).filter((v): v is number => !!v);
    const lastPollAt = polls.length ? Math.max(...polls) : null;
    return {
      id: s.id, name: s.name, host: s.host,
      protocols: own.length,
      running: own.filter(p => p.status === 'running').length,
      lastPollAt,
      // «Не отвечает» имеет смысл только когда есть чему отвечать: сервер без
      // запущенных протоколов воркер не опрашивает вовсе.
      stale: own.some(p => p.status === 'running') && (!lastPollAt || nowSec - lastPollAt > STALE_POLL_SEC),
      dnsInstalled: s.dns_installed === null ? null : s.dns_installed === 1,
      probedAt: s.probed_at,
      probeError: s.probe_error,
      uptimeSec: s.uptime_sec,
      load1: s.load1,
      memTotalMb: s.mem_total_mb,
      memUsedMb: s.mem_used_mb,
      diskTotalMb: s.disk_total_mb,
      diskFreeMb: s.disk_free_mb,
    };
  });

  const serverName = (id: string) => servers.find(s => s.id === id)?.name ?? '—';

  const drifted = protocolRows
    .filter(p => p.drift_image === 1 || p.drift_run_args === 1)
    .map(p => ({
      id: p.id, serverId: p.server_id, serverName: serverName(p.server_id), type: p.type,
      image: p.drift_image === 1, runArgs: p.drift_run_args === 1,
    }));

  // «Молчащий» протокол: запущен, клиенты есть, опрос проходит — а снимков за
  // последний час нет. Для Xray это обычно выключенный stats API: такой протокол
  // выглядит здоровым, но статистики не даёт, а значит и суточный лимит трафика
  // на нём не сработает. Проверка по данным, а не по SSH, поэтому ловит и другие
  // молчаливые поломки сбора.
  const recentlyReporting = new Set(query<{ protocol_id: string }>(`
    SELECT DISTINCT c.protocol_id FROM client_stats s
    JOIN clients c ON c.id = s.client_id
    WHERE s.ts >= ?
  `, [nowSec - HOUR]).map(r => r.protocol_id));

  const silent = protocolRows
    .filter(p => p.status === 'running' && p.clients > 0 && !recentlyReporting.has(p.id))
    .map(p => ({
      id: p.id, serverId: p.server_id, serverName: serverName(p.server_id),
      type: p.type, clients: p.clients,
    }));

  const byType = new Map<ProtocolType, { count: number; clients: number }>();
  for (const p of protocolRows) {
    const acc = byType.get(p.type) ?? { count: 0, clients: 0 };
    acc.count++;
    acc.clients += p.clients;
    byType.set(p.type, acc);
  }

  const userCounts = queryOne<{ total: number; admins: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins FROM users",
  ) ?? { total: 0, admins: 0 };

  const clientCounts = queryOne<{
    total: number; suspended: number; with_limits: number; expiring: number; orphaned: number;
  }>(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN suspended_at IS NOT NULL THEN 1 ELSE 0 END) AS suspended,
           SUM(CASE WHEN expires_at IS NOT NULL OR daily_limit_bytes > 0 THEN 1 ELSE 0 END) AS with_limits,
           SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring,
           SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS orphaned
    FROM clients
  `, [nowSec + EXPIRING_SOON_SEC]) ?? { total: 0, suspended: 0, with_limits: 0, expiring: 0, orphaned: 0 };

  // Онлайн: последний снимок каждого клиента со свежим handshake.
  const online = queryOne<{ n: number }>(`
    SELECT COUNT(*) AS n FROM (
      SELECT client_id, MAX(ts) AS ts, last_handshake
      FROM client_stats GROUP BY client_id
    ) WHERE last_handshake IS NOT NULL AND ? - last_handshake < ?
  `, [nowSec, ONLINE_WINDOW_SEC])?.n ?? 0;

  // Заходившие за сутки: «онлайн сейчас» показывает срез, а востребованность
  // видна по числу клиентов, у которых сегодня вообще было рукопожатие.
  const activeToday = queryOne<{ n: number }>(`
    SELECT COUNT(DISTINCT client_id) AS n FROM client_stats
    WHERE last_handshake IS NOT NULL AND last_handshake >= ?
  `, [dayStartSec(new Date(nowSec * 1000))])?.n ?? 0;

  const samples = hourlySamplesSince(nowSec - TRAFFIC_DAYS * 24 * HOUR);

  const daily = fillMissingDays(trafficByDay(samples), TRAFFIC_DAYS, nowSec);
  const todayKey = dayKey(nowSec);
  const today = daily.find(d => d.day === todayKey) ?? { day: todayKey, rx: 0, tx: 0 };
  const week = daily.slice(-7).reduce((a, d) => ({ rx: a.rx + d.rx, tx: a.tx + d.tx }), { rx: 0, tx: 0 });

  const perClient = trafficByClient(samples);
  // Клиенты без трафика в «топе» выглядят как сбой — их отсекаем.
  const topIds = [...perClient.entries()]
    .filter(([, v]) => v.rx + v.tx > 0)
    .sort((a, b) => (b[1].rx + b[1].tx) - (a[1].rx + a[1].tx))
    .slice(0, TOP_CLIENTS);

  const topClients = topIds.map(([id, v]) => {
    const meta = queryOne<{ name: string; type: ProtocolType; owner: string | null }>(`
      SELECT c.name, p.type, u.username AS owner
      FROM clients c
      JOIN protocols p ON p.id = c.protocol_id
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `, [id]);
    return meta ? { id, name: meta.name, type: meta.type, owner: meta.owner, ...v } : null;
  }).filter((v): v is NonNullable<typeof v> => v !== null);

  return {
    servers: serverSummary,
    protocols: {
      total: protocolRows.length,
      running: protocolRows.filter(p => p.status === 'running').length,
      byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })),
    },
    users: {
      total: userCounts.total,
      admins: userCounts.admins ?? 0,
      regular: userCounts.total - (userCounts.admins ?? 0),
    },
    clients: {
      total: clientCounts.total,
      online,
      activeToday,
      suspended: clientCounts.suspended ?? 0,
      withLimits: clientCounts.with_limits ?? 0,
      expiringSoon: clientCounts.expiring ?? 0,
      orphaned: clientCounts.orphaned ?? 0,
    },
    issues: { drifted, silent },
    storage: storageStats(),
    traffic: { today: { rx: today.rx, tx: today.tx }, week, daily, topClients },
    subscriptions: queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM subscriptions')?.n ?? 0,
  };
}

// Размер файла базы и глубина хранения снимков: видно, что ретеншен работает и
// база не растёт бесконечно. Раньше именно снимки были её основной массой.
function storageStats(): DashboardSummary['storage'] {
  let dbBytes = 0;
  try {
    // В WAL-режиме часть данных лежит в -wal: без него размер занижен.
    for (const suffix of ['', '-wal']) {
      try { dbBytes += fs.statSync(DB_PATH + suffix).size; } catch { /* файла может не быть */ }
    }
  } catch { /* :memory: и прочие не-файловые базы */ }

  const stats = queryOne<{ n: number; oldest: number | null }>(
    'SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM client_stats',
  );
  return {
    dbBytes,
    statsRows: stats?.n ?? 0,
    oldestSnapshotAt: stats?.oldest ?? null,
    retentionDays: RETENTION_DAYS,
  };
}
