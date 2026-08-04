import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_PATH = ':memory:';

type LimitsModule = typeof import('./limits.js');
type DbModule = typeof import('./db.js');

let limits: LimitsModule;
let db: DbModule;

const MB = 1024 * 1024;

beforeAll(async () => {
  db = await import('./db.js');
  await db.getDb();
  limits = await import('./limits.js');

  db.run('INSERT INTO servers (id, name, host, username) VALUES (?, ?, ?, ?)', ['s-1', 'srv', '10.0.0.1', 'root']);
  db.run('INSERT INTO protocols (id, server_id, type, container_name, port, config) VALUES (?, ?, ?, ?, ?, ?)',
    ['p-1', 's-1', 'awg2', 'amnezia-awg2', 51820, '{}']);
  db.run('INSERT INTO clients (id, protocol_id, server_id, name) VALUES (?, ?, ?, ?)', ['c-1', 'p-1', 's-1', 'тест']);
});

beforeEach(() => {
  db.run('DELETE FROM client_stats');
});

describe('границы суток', () => {
  it('полночь локальной зоны, а не момент вызова', () => {
    const noon = new Date(2026, 7, 4, 12, 34, 56);
    const start = limits.dayStartSec(noon);
    expect(new Date(start * 1000).getHours()).toBe(0);
    expect(new Date(start * 1000).getDate()).toBe(4);
  });

  it('момент ровно в полночь принадлежит уже новым суткам', () => {
    const midnight = new Date(2026, 7, 4, 0, 0, 0);
    expect(limits.dayStartSec(midnight)).toBe(Math.floor(midnight.getTime() / 1000));
  });
});

describe('срок действия', () => {
  const now = 1_000_000;

  it('без срока не истекает никогда', () => {
    expect(limits.isExpired({ expires_at: null }, now)).toBe(false);
    expect(limits.isExpired({}, now)).toBe(false);
  });

  it('истекает по достижении момента, не раньше', () => {
    expect(limits.isExpired({ expires_at: now + 1 }, now)).toBe(false);
    expect(limits.isExpired({ expires_at: now }, now)).toBe(true);
    expect(limits.isExpired({ expires_at: now - 1 }, now)).toBe(true);
  });
});

describe('суточный лимит трафика', () => {
  it('0 = без лимита, сколько бы ни было потрачено', () => {
    expect(limits.isOverDailyLimit(500 * MB, { daily_limit_bytes: 0 })).toBe(false);
    expect(limits.isOverDailyLimit(500 * MB, {})).toBe(false);
  });

  it('срабатывает ровно на границе', () => {
    expect(limits.isOverDailyLimit(99 * MB,  { daily_limit_bytes: 100 * MB })).toBe(false);
    expect(limits.isOverDailyLimit(100 * MB, { daily_limit_bytes: 100 * MB })).toBe(true);
  });

  // Возврат — это ровно отрицание исчерпания: отдельного «наступила ли полночь»
  // не нужно, счётчик суток обнуляется сам.
  it('возврат разрешён, как только трафик за сутки ниже лимита', () => {
    expect(limits.shouldResume(100 * MB, { daily_limit_bytes: 100 * MB })).toBe(false);
    expect(limits.shouldResume(0,        { daily_limit_bytes: 100 * MB })).toBe(true);
    // Админ поднял лимит — клиент возвращается, не дожидаясь новых суток.
    expect(limits.shouldResume(100 * MB, { daily_limit_bytes: 500 * MB })).toBe(true);
  });
});

describe('расход за текущие сутки', () => {
  const now = Math.floor(new Date(2026, 7, 4, 12, 0, 0).getTime() / 1000);
  // Полночь считаем внутри тестов: тело describe выполняется до beforeAll,
  // где модуль ещё не импортирован.
  const midnightOf = () => Math.floor(new Date(2026, 7, 4, 0, 0, 0).getTime() / 1000);

  const snap = (ts: number, rx: number, tx: number) =>
    db.run('INSERT INTO client_stats (client_id, ts, rx_bytes, tx_bytes) VALUES (?, ?, ?, ?)', ['c-1', ts, rx, tx]);

  it('без снимков — ноль', () => {
    expect(limits.usedToday('c-1', now)).toBe(0);
  });

  it('считает приращения, а не значение последнего снимка', () => {
    snap(midnightOf() + 100, 10, 5);
    snap(midnightOf() + 200, 30, 15);
    // приращения: rx 20 + tx 10
    expect(limits.usedToday('c-1', now)).toBe(30);
  });

  // Счётчики накопительные с момента старта контейнера, поэтому первый снимок
  // новых суток уже содержит вчерашний трафик — база отсчёта обязана браться
  // из снимка ДО полуночи, иначе вчерашнее засчиталось бы сегодня.
  it('вчерашний трафик не попадает в сегодняшний расход', () => {
    snap(midnightOf() - 600, 1000, 1000);
    snap(midnightOf() + 100, 1010, 1005);
    expect(limits.usedToday('c-1', now)).toBe(15);
  });

  // Рестарт контейнера обнуляет счётчики: отрицательное приращение клампится,
  // иначе после возврата приостановленного пира расход ушёл бы в минус.
  it('обнуление счётчиков не уводит расход в минус', () => {
    snap(midnightOf() + 100, 5000, 5000);
    snap(midnightOf() + 200, 0, 0);      // рестарт / пир вернули с нуля
    snap(midnightOf() + 300, 40, 10);
    expect(limits.usedToday('c-1', now)).toBe(50);
  });
});
