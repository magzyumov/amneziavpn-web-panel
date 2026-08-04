// Сводка для главной страницы. Всё считается из базы — ни одного SSH-вызова:
// дашборд открывают чаще всего, и он не должен зависеть от доступности VPS.
// Живость сервера видна по свежести последнего успешного опроса воркером
// статистики (protocols.last_poll_at), а не по отдельной проверке связи.
//
// Трафик берётся из тех же накопительных снимков client_stats, что и вкладка
// статистики, поэтому цифры на дашборде и в карточке клиента сходятся.
import { query, queryOne } from './db.js';
import type { ProtocolType } from '../types.js';

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

// ─── Сбор сводки ──────────────────────────────────────────────────────────────

const ONLINE_WINDOW_SEC = 180;   // как в статистике клиента: 3 минуты от handshake
const TRAFFIC_DAYS = 14;
const TOP_CLIENTS = 5;
const EXPIRING_SOON_SEC = 24 * HOUR;
// Опрос идёт раз в минуту; три пропуска подряд — уже повод показать протокол
// как «не отвечает», а не мигать на каждой сетевой икоте.
const STALE_POLL_SEC = 5 * 60;

export interface DashboardSummary {
  servers: Array<{
    id: string; name: string; host: string;
    protocols: number; running: number;
    lastPollAt: number | null;
    stale: boolean;
  }>;
  protocols: { total: number; running: number; byType: Array<{ type: ProtocolType; count: number; clients: number }> };
  users: { total: number; admins: number; regular: number };
  clients: {
    total: number; online: number; suspended: number;
    withLimits: number; expiringSoon: number; orphaned: number;
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
  const servers = query<{ id: string; name: string; host: string }>(
    'SELECT id, name, host FROM servers ORDER BY name',
  );

  const protocolRows = query<{
    id: string; server_id: string; type: ProtocolType; status: string; last_poll_at: number | null; clients: number;
  }>(`
    SELECT p.id, p.server_id, p.type, p.status, p.last_poll_at,
           (SELECT COUNT(*) FROM clients c WHERE c.protocol_id = p.id) AS clients
    FROM protocols p
  `);

  const serverSummary = servers.map(s => {
    const own = protocolRows.filter(p => p.server_id === s.id);
    const polls = own.map(p => p.last_poll_at).filter((v): v is number => !!v);
    const lastPollAt = polls.length ? Math.max(...polls) : null;
    return {
      ...s,
      protocols: own.length,
      running: own.filter(p => p.status === 'running').length,
      lastPollAt,
      // «Не отвечает» имеет смысл только когда есть чему отвечать: сервер без
      // запущенных протоколов воркер не опрашивает вовсе.
      stale: own.some(p => p.status === 'running') && (!lastPollAt || nowSec - lastPollAt > STALE_POLL_SEC),
    };
  });

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

  // Прореживание до одного снимка в час делает SQLite: при MIN/MAX остальные
  // колонки берутся из той же строки — это документированное поведение.
  const since = nowSec - TRAFFIC_DAYS * 24 * HOUR;
  const samples = query<HourlySample>(`
    SELECT client_id, MAX(ts) AS ts, rx_bytes, tx_bytes
    FROM client_stats
    WHERE ts >= ?
    GROUP BY client_id, ts / ${HOUR}
    ORDER BY client_id ASC, ts ASC
  `, [since]);

  const daily = fillMissingDays(trafficByDay(samples), TRAFFIC_DAYS, nowSec);
  const todayKey = dayKey(nowSec);
  const today = daily.find(d => d.day === todayKey) ?? { day: todayKey, rx: 0, tx: 0 };
  const week = daily.slice(-7).reduce((a, d) => ({ rx: a.rx + d.rx, tx: a.tx + d.tx }), { rx: 0, tx: 0 });

  const perClient = trafficByClient(samples);
  const topIds = [...perClient.entries()]
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
      suspended: clientCounts.suspended ?? 0,
      withLimits: clientCounts.with_limits ?? 0,
      expiringSoon: clientCounts.expiring ?? 0,
      orphaned: clientCounts.orphaned ?? 0,
    },
    traffic: { today: { rx: today.rx, tx: today.tx }, week, daily, topClients },
    subscriptions: queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM subscriptions')?.n ?? 0,
  };
}
