import { describe, it, expect, beforeAll } from 'vitest';

// DB_PATH читается на импорте модуля, поэтому подменяем до динамического import.
process.env.DB_PATH = ':memory:';

type DbModule = typeof import('./db.js');
let db: DbModule;

beforeAll(async () => {
  db = await import('./db.js');
  await db.getDb();
});

describe('слой БД', () => {
  it('run/query делают полный круг', () => {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['k1', 'v1']);
    expect(db.query<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['k1']))
      .toEqual([{ value: 'v1' }]);
  });

  it('queryOne возвращает null, а не undefined, когда строк нет', () => {
    expect(db.queryOne('SELECT * FROM settings WHERE key = ?', ['нет такого'])).toBeNull();
  });

  it('queryOne отдаёт первую строку', () => {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['k2', 'v2']);
    expect(db.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['k2']))
      .toEqual({ value: 'v2' });
  });

  // sql.js молча принимал undefined и boolean; при переходе на better-sqlite3
  // такие параметры бросали бы исключение прямо в рантайме роутов.
  it('undefined приводится к NULL', () => {
    db.run('INSERT INTO servers (id, name, host, username, password) VALUES (?, ?, ?, ?, ?)',
      ['s1', 'srv', '10.0.0.1', 'root', undefined]);
    expect(db.queryOne<{ password: string | null }>('SELECT password FROM servers WHERE id = ?', ['s1']))
      .toEqual({ password: null });
  });

  it('boolean приводится к 0/1', () => {
    db.run('INSERT INTO servers (id, name, host, username, port) VALUES (?, ?, ?, ?, ?)',
      ['s2', 'srv2', '10.0.0.2', 'root', true]);
    expect(db.queryOne<{ port: number }>('SELECT port FROM servers WHERE id = ?', ['s2']))
      .toEqual({ port: 1 });
  });

  it('схема создана целиком', () => {
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map(r => r.name);
    for (const t of ['client_stats', 'clients', 'protocols', 'servers', 'settings', 'subscriptions', 'users']) {
      expect(tables).toContain(t);
    }
  });

  it('колонка peer_id на месте — миграция отработала', () => {
    const cols = db.query<{ name: string }>("PRAGMA table_info('clients')").map(c => c.name);
    expect(cols).toContain('peer_id');
  });
});
