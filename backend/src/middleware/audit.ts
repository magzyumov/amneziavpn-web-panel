// Автоматическая запись действий в журнал.
//
// Пишем по событию finish, а не в хендлере: к этому моменту известен и код
// ответа, и заполненный authMiddleware'ом req.user, и то, чем хендлер дополнил
// запись. Отказы (403/404/401) пишутся тоже — попытка сделать чужое ценнее для
// разбора, чем успешное действие.
import type { Request, Response, NextFunction } from 'express';
import { describeAction, recordAudit, type AuditStatus } from '../services/audit.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Хендлер дополняет запись именем объекта — id из пути ничего не говорит. */
    auditTarget?: { id?: string | null; name?: string | null; type?: string | null };
    /** Безопасные подробности действия. Секретов здесь быть не должно. */
    auditDetails?: Record<string, unknown>;
    /** Имя пользователя для действий без сессии (неудачный вход). */
    auditActor?: string;
  }
}

function statusOf(httpStatus: number): AuditStatus {
  if (httpStatus < 400) return 'ok';
  // 401/403/404 на защищённых роутах — это отказ в доступе, а не поломка.
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return 'denied';
  return 'failed';
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const info = describeAction(req.method, req.originalUrl);
  if (!info) { next(); return; }

  res.on('finish', () => {
    const user = req.user;
    recordAudit({
      ts: Math.floor(Date.now() / 1000),
      userId: user?.id ?? null,
      // Для неудачного входа сессии нет: имя берём из того, что подставил роут.
      username: user?.username ?? req.auditActor ?? 'аноним',
      role: user?.role ?? null,
      action: info.action,
      targetType: req.auditTarget?.type ?? info.targetType,
      targetId: req.auditTarget?.id ?? null,
      targetName: req.auditTarget?.name ?? null,
      details: req.auditDetails ?? null,
      ip: req.ip ?? null,
      status: statusOf(res.statusCode),
      httpStatus: res.statusCode,
    });
  });

  next();
}

// Хелпер для хендлеров: назвать объект действия, чтобы в журнале было
// «удалил клиента iPhone», а не «удалил client 7fb860f8…».
export function auditTarget(
  req: Request, target: { id?: string | null; name?: string | null; type?: string | null },
): void {
  req.auditTarget = { ...req.auditTarget, ...target };
}

export function auditDetails(req: Request, details: Record<string, unknown>): void {
  req.auditDetails = { ...req.auditDetails, ...details };
}
