// Журнал действий пользователей панели.
//
// Записи делает middleware (middleware/audit.ts) по факту завершения запроса,
// а не хендлеры вручную: расставленные по коду вызовы неизбежно где-то забудут,
// а незалогированное действие в журнале аудита хуже, чем отсутствие журнала.
// Хендлеры только ДОПОЛНЯЮТ запись именем объекта — см. auditTarget().
//
// Тела запросов не пишутся принципиально: там пароли, приватные ключи и
// SSH-креды. В details попадает только то, что положил хендлер явно.
import { query, queryOne, run } from './db.js';
import { logger } from './logger.js';

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 90;

export type AuditStatus = 'ok' | 'denied' | 'failed';

export interface AuditEntry {
  ts: number;
  userId: string | null;
  username: string;
  role: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
  status: AuditStatus;
  httpStatus?: number | null;
}

export function recordAudit(entry: AuditEntry): void {
  try {
    run(`INSERT INTO audit_log
         (ts, user_id, username, role, action, target_type, target_id, target_name, details, ip, status, http_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.ts, entry.userId, entry.username, entry.role, entry.action,
        entry.targetType ?? null, entry.targetId ?? null, entry.targetName ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null, entry.status, entry.httpStatus ?? null,
      ]);
  } catch (e) {
    // Журнал не должен ронять само действие: пользователь уже получил ответ.
    logger.error({ err: e, action: entry.action }, 'audit write failed');
  }
}

// ─── Разбор запроса в действие ────────────────────────────────────────────────

// Сегменты-идентификаторы схлопываем в :id, чтобы путь превращался в конечное
// множество действий. uuid, числовые id и slug'и подписок сюда попадают.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeSegment(seg: string): string {
  if (UUID_RE.test(seg)) return ':id';
  if (/^\d+$/.test(seg)) return ':id';
  // Прочие длинные непонятные строки — тоже идентификаторы (slug, sha).
  if (seg.length > 24) return ':id';
  return seg;
}

export interface ActionInfo {
  action: string;
  targetType: string | null;
}

// Метод + путь → устойчивое имя действия. Неизвестные изменяющие запросы
// получают действие вида 'other:POST /api/…' и всё равно попадают в журнал:
// новый роут, о котором забыли, обязан быть виден, а не пропасть молча.
export function describeAction(method: string, path: string): ActionInfo | null {
  const clean = path.split('?')[0].replace(/^\/api/, '');
  const key = `${method.toUpperCase()} ${clean.split('/').map(normalizeSegment).join('/')}`;

  const map: Record<string, ActionInfo> = {
    'POST /auth/login':   { action: 'auth.login',  targetType: null },
    'POST /auth/logout':  { action: 'auth.logout', targetType: null },
    'POST /auth/setup':   { action: 'auth.setup',  targetType: 'user' },

    'POST /users':        { action: 'user.create', targetType: 'user' },
    'PUT /users/:id':     { action: 'user.update', targetType: 'user' },
    'DELETE /users/:id':  { action: 'user.delete', targetType: 'user' },

    'POST /clients':                  { action: 'client.create',   targetType: 'client' },
    'DELETE /clients/:id':            { action: 'client.delete',   targetType: 'client' },
    'PUT /clients/:id/limits':        { action: 'client.limits',   targetType: 'client' },
    'GET /clients/:id/config':         { action: 'client.download', targetType: 'client' },
    'GET /clients/:id/config-amnezia': { action: 'client.download', targetType: 'client' },

    'POST /protocols/server/:id':      { action: 'protocol.install',      targetType: 'protocol' },
    'DELETE /protocols/:id':           { action: 'protocol.delete',       targetType: 'protocol' },
    'POST /protocols/:id/start':       { action: 'protocol.start',        targetType: 'protocol' },
    'POST /protocols/:id/stop':        { action: 'protocol.stop',         targetType: 'protocol' },
    'POST /protocols/:id/enable-stats': { action: 'protocol.enable_stats', targetType: 'protocol' },

    'POST /servers':                    { action: 'server.create',        targetType: 'server' },
    'PUT /servers/:id':                 { action: 'server.update',        targetType: 'server' },
    'DELETE /servers/:id':              { action: 'server.delete',        targetType: 'server' },
    'POST /servers/:id/test':           { action: 'server.test',          targetType: 'server' },
    'POST /servers/:id/ensure-docker':  { action: 'server.ensure_docker', targetType: 'server' },
    'POST /servers/:id/dns':            { action: 'server.dns_install',   targetType: 'server' },
    'DELETE /servers/:id/dns':          { action: 'server.dns_remove',    targetType: 'server' },
    'POST /servers/:id/scan-protocols': { action: 'server.scan',          targetType: 'server' },
    'POST /servers/:id/import-protocol': { action: 'protocol.import',     targetType: 'protocol' },

    'POST /subscriptions/template':       { action: 'subscription.template',       targetType: null },
    'POST /subscriptions/template/reset': { action: 'subscription.template_reset', targetType: null },
    'POST /subscriptions/regenerate':     { action: 'subscription.regenerate',     targetType: null },
    'POST /subscriptions/settings':       { action: 'subscription.settings',       targetType: null },
    'DELETE /subscriptions/:id':          { action: 'subscription.delete',         targetType: 'subscription' },

    'POST /dashboard/probe': { action: 'server.probe', targetType: null },
  };

  if (map[key]) return map[key];

  // Изменяющее и незнакомое — пишем как есть. Чтение незнакомого не пишем:
  // журнал не должен превращаться в access-log.
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    return { action: `other:${key}`, targetType: null };
  }
  return null;
}

// ─── Чтение журнала ───────────────────────────────────────────────────────────

export interface AuditRow {
  id: number;
  ts: number;
  user_id: string | null;
  username: string;
  role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details: string | null;
  ip: string | null;
  status: AuditStatus;
  http_status: number | null;
}

export interface AuditFilter {
  username?: string;
  action?: string;
  status?: AuditStatus;
  since?: number;
  limit: number;
  offset: number;
}

export function listAudit(f: AuditFilter): { rows: Array<Omit<AuditRow, 'details'> & { details: unknown }>; total: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (f.username) { where.push('username = ?'); params.push(f.username); }
  if (f.action)   { where.push('action = ?');   params.push(f.action); }
  if (f.status)   { where.push('status = ?');   params.push(f.status); }
  if (f.since)    { where.push('ts >= ?');      params.push(f.since); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, params)?.n ?? 0;
  const rows = query<AuditRow>(
    `SELECT * FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, f.offset],
  );

  return {
    total,
    rows: rows.map(r => ({ ...r, details: r.details ? safeParse(r.details) : null })),
  };
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

// Кто вообще встречается в журнале — для выпадающих списков фильтра.
export function auditFacets(): { usernames: string[]; actions: string[] } {
  return {
    usernames: query<{ username: string }>('SELECT DISTINCT username FROM audit_log ORDER BY username').map(r => r.username),
    actions:   query<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action').map(r => r.action),
  };
}

// Журнал не должен расти вечно — чистится тем же воркером, что и снимки
// статистики.
export function purgeOldAudit(): void {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 24 * 60 * 60;
  try {
    run('DELETE FROM audit_log WHERE ts < ?', [cutoff]);
  } catch (e) {
    logger.error({ err: e }, 'audit purge failed');
  }
}

export { RETENTION_DAYS as AUDIT_RETENTION_DAYS };
