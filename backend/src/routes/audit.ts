// Журнал действий. Только для админов и только на чтение: журнал, который
// можно править из интерфейса, ничего не доказывает.
import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { listAudit, auditFacets, AUDIT_RETENTION_DAYS, type AuditStatus } from '../services/audit.js';

const router = Router();
router.use(authMiddleware);
router.use(requireAdmin);

const MAX_LIMIT = 200;

router.get('/', (req: Request, res: Response) => {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const int = (v: unknown, def: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  };

  const statusParam = str(req.query.status);
  const status = statusParam === 'ok' || statusParam === 'denied' || statusParam === 'failed'
    ? (statusParam as AuditStatus)
    : undefined;

  const result = listAudit({
    username: str(req.query.username),
    action: str(req.query.action),
    status,
    since: req.query.since ? int(req.query.since, 0) : undefined,
    limit: Math.min(MAX_LIMIT, int(req.query.limit, 50) || 50),
    offset: int(req.query.offset, 0),
  });

  res.json({ ...result, retentionDays: AUDIT_RETENTION_DAYS, ...auditFacets() });
});

export default router;
