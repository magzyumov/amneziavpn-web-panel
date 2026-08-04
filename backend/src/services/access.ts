// Разграничение прав. Ролей две:
//
//   admin — всё, включая серверы (а значит и SSH-креды), установку и удаление
//           протоколов, управление пользователями;
//   user  — только самообслуживание: завести себе клиента на выданном ему
//           протоколе, скачать конфиг, посмотреть свою статистику, удалить своё.
//
// Что именно выдано обычному пользователю, хранится в user_protocols. Сервер
// отдельно не выдаётся: доступ к серверу выводится из выданных на нём протоколов
// (см. комментарий к таблице в db.ts), поэтому рассинхронизация невозможна.
import { query, queryOne, run } from './db.js';
import type { ProtocolType } from '../types.js';

// Минимум, который нужен для проверок, — чтобы функции можно было звать и от
// req.user, и от строки из БД в тестах. req.user (AuthUser) подходит структурно.
export interface AccessSubject {
  id: string;
  role: string;
  clientLimit?: number;
}

export function isAdmin(user: AccessSubject): boolean {
  return user.role === 'admin';
}

// Владение клиентом. user_id = NULL означает «ничей»: так выглядят клиенты,
// оставшиеся от удалённого пользователя. Их видит только админ — молча отдавать
// их следующему юзеру нельзя.
export function canAccessClient(client: { user_id?: string | null }, user: AccessSubject): boolean {
  if (isAdmin(user)) return true;
  return !!client.user_id && client.user_id === user.id;
}

// Лимит на самостоятельное создание клиентов. 0 (и любое неположительное) —
// без ограничения; на админов лимит не распространяется.
export function quotaReached(currentCount: number, user: AccessSubject): boolean {
  if (isAdmin(user)) return false;
  const limit = user.clientLimit ?? 0;
  if (limit <= 0) return false;
  return currentCount >= limit;
}

// ─── Выданные протоколы ───────────────────────────────────────────────────────

export function grantedProtocolIds(userId: string): string[] {
  return query<{ protocol_id: string }>(
    'SELECT protocol_id FROM user_protocols WHERE user_id = ?', [userId],
  ).map(r => r.protocol_id);
}

export function canUseProtocol(user: AccessSubject, protocolId: string): boolean {
  if (isAdmin(user)) return true;
  return !!queryOne(
    'SELECT 1 FROM user_protocols WHERE user_id = ? AND protocol_id = ?', [user.id, protocolId],
  );
}

// Полная замена набора выданных протоколов. Несуществующие id отбрасываем,
// иначе в таблице копились бы висячие строки (внешние ключи в базе выключены).
export function setUserProtocols(userId: string, protocolIds: string[]): string[] {
  const existing = new Set(
    query<{ id: string }>('SELECT id FROM protocols').map(r => r.id),
  );
  const valid = [...new Set(protocolIds)].filter(id => existing.has(id));
  run('DELETE FROM user_protocols WHERE user_id = ?', [userId]);
  for (const id of valid) {
    run('INSERT INTO user_protocols (user_id, protocol_id) VALUES (?, ?)', [userId, id]);
  }
  return valid;
}

// Чистка выдач при удалении протокола/пользователя. ON DELETE CASCADE не
// сработает: foreign_keys в базе намеренно выключены (см. db.ts).
export function revokeProtocolGrants(protocolId: string): void {
  run('DELETE FROM user_protocols WHERE protocol_id = ?', [protocolId]);
}

export function revokeUserGrants(userId: string): void {
  run('DELETE FROM user_protocols WHERE user_id = ?', [userId]);
}

// ─── Что пользователь видит ───────────────────────────────────────────────────

export interface AccessibleProtocol {
  id: string;
  type: ProtocolType;
  config: Record<string, unknown>;
  status: string;
  server_id: string;
  server_name: string;
}

// Протоколы, на которых пользователь может завести себе клиента. Админ видит все.
// Наружу отдаём только то, что нужно для выбора: ни container_name, ни портов,
// ни тем более данных сервера здесь нет.
export function accessibleProtocols(user: AccessSubject): AccessibleProtocol[] {
  const base = `
    SELECT p.id, p.type, p.config, p.status, p.server_id, s.name AS server_name
    FROM protocols p
    JOIN servers s ON s.id = p.server_id
  `;
  const rows = isAdmin(user)
    ? query<Omit<AccessibleProtocol, 'config'> & { config: string | null }>(base)
    : query<Omit<AccessibleProtocol, 'config'> & { config: string | null }>(
        `${base} JOIN user_protocols up ON up.protocol_id = p.id AND up.user_id = ?`, [user.id],
      );

  return rows.map(r => ({ ...r, config: r.config ? safeParse(r.config) : {} }));
}

function safeParse(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

export function countUserClients(userId: string): number {
  const row = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM clients WHERE user_id = ?', [userId]);
  return row?.n ?? 0;
}
