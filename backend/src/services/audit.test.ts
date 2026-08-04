import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_PATH = ':memory:';

import { describeAction } from './audit.js';

type AuditModule = typeof import('./audit.js');
type DbModule = typeof import('./db.js');

let audit: AuditModule;
let db: DbModule;

beforeAll(async () => {
  db = await import('./db.js');
  await db.getDb();
  audit = await import('./audit.js');
});

beforeEach(() => {
  db.run('DELETE FROM audit_log');
});

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('разбор запроса в действие', () => {
  it('узнаёт действия с идентификатором в пути', () => {
    expect(describeAction('DELETE', `/api/clients/${UUID}`))
      .toEqual({ action: 'client.delete', targetType: 'client' });
    expect(describeAction('PUT', `/api/clients/${UUID}/limits`))
      .toEqual({ action: 'client.limits', targetType: 'client' });
    expect(describeAction('POST', `/api/protocols/server/${UUID}`))
      .toEqual({ action: 'protocol.install', targetType: 'protocol' });
  });

  it('вход и выход различаются', () => {
    expect(describeAction('POST', '/api/auth/login')?.action).toBe('auth.login');
    expect(describeAction('POST', '/api/auth/logout')?.action).toBe('auth.logout');
  });

  it('query-строка не мешает опознать действие', () => {
    expect(describeAction('DELETE', `/api/clients/${UUID}?foo=bar`)?.action).toBe('client.delete');
  });

  // Скачивание чужого конфига — событие безопасности, его надо видеть.
  it('скачивание конфига логируется, несмотря на GET', () => {
    expect(describeAction('GET', `/api/clients/${UUID}/config`)?.action).toBe('client.download');
    expect(describeAction('GET', `/api/clients/${UUID}/config-amnezia`)?.action).toBe('client.download');
  });

  // Журнал не должен превращаться в access-log: обычное чтение не пишем.
  it('прочие GET не логируются', () => {
    expect(describeAction('GET', '/api/clients/mine')).toBeNull();
    expect(describeAction('GET', '/api/dashboard')).toBeNull();
    expect(describeAction('GET', `/api/clients/${UUID}/stats`)).toBeNull();
  });

  // Новый роут, о котором забыли, обязан быть виден, а не пропасть молча.
  it('незнакомое изменяющее действие всё равно попадает в журнал', () => {
    const info = describeAction('POST', '/api/что-то/новое');
    expect(info).not.toBeNull();
    expect(info!.action).toMatch(/^other:POST /);
  });

  it('числовые идентификаторы тоже схлопываются', () => {
    expect(describeAction('DELETE', '/api/subscriptions/42')?.action).toBe('subscription.delete');
  });
});

describe('запись и чтение журнала', () => {
  const entry = (over: Partial<Parameters<AuditModule['recordAudit']>[0]> = {}) => ({
    ts: 1_000_000,
    userId: 'u-1',
    username: 'admin',
    role: 'admin',
    action: 'client.create',
    status: 'ok' as const,
    ...over,
  });

  it('запись возвращается чтением', () => {
    audit.recordAudit(entry({ targetName: 'iPhone', targetType: 'client', targetId: 'c-1' }));
    const { rows, total } = audit.listAudit({ limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      username: 'admin', action: 'client.create', target_name: 'iPhone', status: 'ok',
    });
  });

  it('details хранятся как JSON и разбираются обратно', () => {
    audit.recordAudit(entry({ details: { protocol: 'awg2', dailyLimitMb: 500 } }));
    expect(audit.listAudit({ limit: 10, offset: 0 }).rows[0].details)
      .toEqual({ protocol: 'awg2', dailyLimitMb: 500 });
  });

  // Смысл журнала — пережить удаление того, о чём он рассказывает: имена
  // хранятся снимком, а не ссылкой на живые строки.
  it('имена сохраняются, даже если пользователя и объекта уже нет', () => {
    audit.recordAudit(entry({ userId: 'удалённый', username: 'bukhariev.bm', targetName: 'Мой телефон' }));
    const row = audit.listAudit({ limit: 10, offset: 0 }).rows[0];
    expect(row.username).toBe('bukhariev.bm');
    expect(row.target_name).toBe('Мой телефон');
  });

  it('новые записи идут первыми', () => {
    audit.recordAudit(entry({ ts: 100, action: 'старое' }));
    audit.recordAudit(entry({ ts: 200, action: 'новое' }));
    expect(audit.listAudit({ limit: 10, offset: 0 }).rows.map(r => r.action)).toEqual(['новое', 'старое']);
  });

  it('фильтры по пользователю, действию и статусу', () => {
    audit.recordAudit(entry({ username: 'admin', action: 'client.create', status: 'ok' }));
    audit.recordAudit(entry({ username: 'petya', action: 'client.delete', status: 'denied' }));

    expect(audit.listAudit({ username: 'petya', limit: 10, offset: 0 }).total).toBe(1);
    expect(audit.listAudit({ action: 'client.create', limit: 10, offset: 0 }).total).toBe(1);
    expect(audit.listAudit({ status: 'denied', limit: 10, offset: 0 }).rows[0].username).toBe('petya');
  });

  it('постраничная выдача: total не зависит от limit', () => {
    for (let i = 0; i < 5; i++) audit.recordAudit(entry({ ts: 1000 + i }));
    const page = audit.listAudit({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.rows).toHaveLength(2);
  });

  it('facets собирают встреченные имена и действия', () => {
    audit.recordAudit(entry({ username: 'admin', action: 'auth.login' }));
    audit.recordAudit(entry({ username: 'petya', action: 'client.create' }));
    const f = audit.auditFacets();
    expect(f.usernames).toEqual(['admin', 'petya']);
    expect(f.actions).toEqual(['auth.login', 'client.create']);
  });
});
