// Лимиты клиента: срок действия и суточный трафик.
//
// Срок действия — жёсткий: по истечении клиент удаляется вместе с пиром на
// сервере, как если бы его удалили руками.
//
// Суточный трафик — мягкий: при исчерпании пир снимается с сервера
// (приостановка), а с началом новых суток возвращается тем же ключом. Удалять
// клиента за перерасход нельзя: «лимит в сутки» подразумевает, что завтра
// доступ есть снова, а выданный профиль должен пережить приостановку.
//
// Считаем по тому же источнику, что и вкладка статистики: снимки client_stats
// накопительные, поэтому трафик за сутки — сумма положительных приращений от
// последнего снимка ДО полуночи (он и есть база отсчёта).
import { query, queryOne } from './db.js';
import { sumTraffic } from './statsAggregate.js';
import { deleteClientCompletely, suspendClient, resumeClient } from './clientLifecycle.js';
import { logger } from './logger.js';
import type { Client } from '../types.js';

// Начало текущих суток в ЛОКАЛЬНОЙ зоне процесса. Часовой пояс задаётся
// переменной TZ у контейнера backend'а: без неё это UTC, и «сутки» для Москвы
// начинались бы в 03:00.
export function dayStartSec(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function isExpired(client: Pick<Client, 'expires_at'>, nowSec: number): boolean {
  return !!client.expires_at && client.expires_at <= nowSec;
}

// Лимит исчерпан. 0 (и отсутствие значения) — без лимита.
export function isOverDailyLimit(usedBytes: number, client: Pick<Client, 'daily_limit_bytes'>): boolean {
  const limit = client.daily_limit_bytes ?? 0;
  return limit > 0 && usedBytes >= limit;
}

// Приостановленный клиент возвращается, как только его трафик за ТЕКУЩИЕ сутки
// опускается ниже лимита. Отдельной проверки «наступила ли полночь» не нужно:
// счётчик суток обнуляется сам, и это же правило корректно отрабатывает, если
// администратор просто поднял лимит.
export function shouldResume(usedBytes: number, client: Pick<Client, 'daily_limit_bytes'>): boolean {
  return !isOverDailyLimit(usedBytes, client);
}

// Трафик клиента за текущие сутки, байт (rx + tx).
export function usedToday(clientId: string, nowSec: number = Math.floor(Date.now() / 1000)): number {
  const since = dayStartSec(new Date(nowSec * 1000));

  const rows = query<{ ts: number; rx_bytes: number; tx_bytes: number }>(
    'SELECT ts, rx_bytes, tx_bytes FROM client_stats WHERE client_id = ? AND ts >= ? ORDER BY ts ASC',
    [clientId, since],
  );
  // Снимок перед полуночью — база отсчёта, иначе терялся бы трафик между ним и
  // первым снимком новых суток.
  const baseline = queryOne<{ ts: number; rx_bytes: number; tx_bytes: number }>(
    'SELECT ts, rx_bytes, tx_bytes FROM client_stats WHERE client_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1',
    [clientId, since],
  );

  const total = sumTraffic(baseline ? [baseline, ...rows] : rows);
  return total.rx + total.tx;
}

interface LimitedClient extends Client {
  daily_limit_bytes: number;
}

// Приведение одного клиента к его лимитам. Тем же вызовом пользуется роут
// смены лимитов: подняли суточный порог — приостановка снимается сразу, а не
// на следующем тике воркера.
export async function enforceLimitsForClient(
  client: Client, nowSec: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (isExpired(client, nowSec)) {
    await deleteClientCompletely(client);
    logger.info({ client: client.id, name: client.name }, 'client expired and removed');
    return;
  }

  const limited = { daily_limit_bytes: client.daily_limit_bytes ?? 0 };
  const used = limited.daily_limit_bytes ? usedToday(client.id, nowSec) : 0;

  if (!client.suspended_at && isOverDailyLimit(used, limited)) {
    await suspendClient(client);
    logger.info({ client: client.id, name: client.name, used, limit: limited.daily_limit_bytes },
      'client suspended: daily traffic limit reached');
  } else if (client.suspended_at && shouldResume(used, limited)) {
    await resumeClient(client);
    logger.info({ client: client.id, name: client.name }, 'client resumed');
  }
}

// Один проход по клиентам, у которых вообще есть лимиты. Зовётся воркером
// статистики сразу после снятия снимков, чтобы решение принималось по свежим
// цифрам.
//
// Ошибка по одному клиенту не должна останавливать проверку остальных: сервер
// может быть недоступен, и тогда мы просто попробуем на следующем тике.
export async function enforceLimits(nowSec: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const clients = query<LimitedClient>(
    'SELECT * FROM clients WHERE expires_at IS NOT NULL OR daily_limit_bytes > 0 OR suspended_at IS NOT NULL',
  );

  for (const client of clients) {
    try {
      await enforceLimitsForClient(client, nowSec);
    } catch (e) {
      logger.error({ err: e, client: client.id }, 'limit enforcement failed for client');
    }
  }
}
