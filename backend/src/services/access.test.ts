import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// DB_PATH читается на импорте модуля, поэтому подменяем до динамического import.
process.env.DB_PATH = ':memory:';

type AccessModule = typeof import('./access.js');
type DbModule = typeof import('./db.js');

let access: AccessModule;
let db: DbModule;

const admin = { id: 'u-admin', role: 'admin', clientLimit: 0 };
const user  = { id: 'u-1',     role: 'user',  clientLimit: 3 };
const other = { id: 'u-2',     role: 'user',  clientLimit: 3 };

beforeAll(async () => {
  db = await import('./db.js');
  await db.getDb();
  access = await import('./access.js');

  db.run('INSERT INTO servers (id, name, host, username) VALUES (?, ?, ?, ?)', ['s-1', 'Прод', '10.0.0.1', 'root']);
  db.run('INSERT INTO servers (id, name, host, username) VALUES (?, ?, ?, ?)', ['s-2', 'Тест', '10.0.0.2', 'root']);
  for (const [id, serverId] of [['p-1', 's-1'], ['p-2', 's-1'], ['p-3', 's-2']]) {
    db.run('INSERT INTO protocols (id, server_id, type, container_name, port, config) VALUES (?, ?, ?, ?, ?, ?)',
      [id, serverId, 'awg2', `amnezia-${id}`, 51820, '{"port":51820}']);
  }
});

beforeEach(() => {
  db.run('DELETE FROM user_protocols');
  db.run('DELETE FROM clients');
});

describe('владение клиентом', () => {
  it('свой клиент доступен', () => {
    expect(access.canAccessClient({ user_id: 'u-1' }, user)).toBe(true);
  });

  it('чужой — нет', () => {
    expect(access.canAccessClient({ user_id: 'u-2' }, user)).toBe(false);
  });

  // Клиенты, оставшиеся от удалённого пользователя, не должны доставаться
  // следующему юзеру просто потому, что владелец не проставлен.
  it('«ничей» клиент обычному пользователю недоступен', () => {
    expect(access.canAccessClient({ user_id: null }, user)).toBe(false);
    expect(access.canAccessClient({}, user)).toBe(false);
  });

  it('админу доступно всё, включая ничьё', () => {
    expect(access.canAccessClient({ user_id: 'u-2' }, admin)).toBe(true);
    expect(access.canAccessClient({ user_id: null }, admin)).toBe(true);
  });
});

describe('лимит клиентов', () => {
  it('не достигнут, пока меньше лимита', () => {
    expect(access.quotaReached(2, user)).toBe(false);
  });

  it('достигнут ровно на границе', () => {
    expect(access.quotaReached(3, user)).toBe(true);
    expect(access.quotaReached(4, user)).toBe(true);
  });

  it('0 = без ограничения', () => {
    expect(access.quotaReached(500, { id: 'u-3', role: 'user', clientLimit: 0 })).toBe(false);
  });

  it('на админов не распространяется', () => {
    expect(access.quotaReached(500, { id: 'u-admin', role: 'admin', clientLimit: 1 })).toBe(false);
  });
});

describe('выданные протоколы', () => {
  it('без выдачи пользователю недоступно ничего', () => {
    expect(access.canUseProtocol(user, 'p-1')).toBe(false);
    expect(access.accessibleProtocols(user)).toEqual([]);
  });

  it('выдача открывает ровно один протокол, а не весь сервер', () => {
    access.setUserProtocols(user.id, ['p-1']);
    expect(access.canUseProtocol(user, 'p-1')).toBe(true);
    // p-2 стоит на том же сервере s-1 — доступ на него не распространяется.
    expect(access.canUseProtocol(user, 'p-2')).toBe(false);
    expect(access.accessibleProtocols(user).map(p => p.id)).toEqual(['p-1']);
  });

  it('выдача одного пользователя не влияет на другого', () => {
    access.setUserProtocols(user.id, ['p-1', 'p-3']);
    expect(access.canUseProtocol(other, 'p-1')).toBe(false);
  });

  it('setUserProtocols заменяет набор целиком и отбрасывает несуществующие id', () => {
    access.setUserProtocols(user.id, ['p-1', 'p-2']);
    const kept = access.setUserProtocols(user.id, ['p-3', 'нет-такого']);
    expect(kept).toEqual(['p-3']);
    expect(access.grantedProtocolIds(user.id)).toEqual(['p-3']);
  });

  it('админу доступны все протоколы без единой записи в user_protocols', () => {
    expect(access.grantedProtocolIds(admin.id)).toEqual([]);
    expect(access.canUseProtocol(admin, 'p-3')).toBe(true);
    expect(access.accessibleProtocols(admin).map(p => p.id).sort()).toEqual(['p-1', 'p-2', 'p-3']);
  });

  it('accessibleProtocols отдаёт имя сервера и разобранный config', () => {
    access.setUserProtocols(user.id, ['p-3']);
    const [p] = access.accessibleProtocols(user);
    expect(p.server_name).toBe('Тест');
    expect(p.config).toEqual({ port: 51820 });
  });

  it('удаление протокола снимает выдачи', () => {
    access.setUserProtocols(user.id, ['p-1', 'p-2']);
    access.revokeProtocolGrants('p-1');
    expect(access.grantedProtocolIds(user.id)).toEqual(['p-2']);
  });
});

describe('счётчик клиентов пользователя', () => {
  it('считает только своих', () => {
    db.run('INSERT INTO clients (id, protocol_id, server_id, name, user_id) VALUES (?, ?, ?, ?, ?)', ['c-1', 'p-1', 's-1', 'a', 'u-1']);
    db.run('INSERT INTO clients (id, protocol_id, server_id, name, user_id) VALUES (?, ?, ?, ?, ?)', ['c-2', 'p-1', 's-1', 'b', 'u-1']);
    db.run('INSERT INTO clients (id, protocol_id, server_id, name, user_id) VALUES (?, ?, ?, ?, ?)', ['c-3', 'p-1', 's-1', 'c', 'u-2']);
    db.run('INSERT INTO clients (id, protocol_id, server_id, name) VALUES (?, ?, ?, ?)', ['c-4', 'p-1', 's-1', 'ничей']);
    expect(access.countUserClients('u-1')).toBe(2);
    expect(access.countUserClients('u-2')).toBe(1);
  });
});
