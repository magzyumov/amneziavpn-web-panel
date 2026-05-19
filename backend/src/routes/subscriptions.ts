import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  getTemplate, saveTemplate, getVpsHost, saveVpsHost,
  listSubscriptions, deleteSubscription,
  regenerateAllSubscriptions, getSubscriptionBySlug,
  DEFAULT_TEMPLATE,
} from '../services/subscription.js';

const router = Router();

// Rate-limit на публичный endpoint подписок. 30 req/min на IP — это с запасом
// для FLClash/Clash, которые обновляются раз в минуту-час. Любая попытка
// перебрать slug (192 бита энтропии) упрётся в этот лимит задолго до угадывания.
const subLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests',
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
});

// GET /sub/:slug — публичный endpoint (без авторизации)
router.get('/sub/:slug', subLimiter, (req: Request, res: Response) => {
  const sub = getSubscriptionBySlug(req.params.slug);
  if (!sub) return res.status(404).send('# Subscription not found\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${sub.client_name}.yaml"`);
  res.send(sub.yaml_content);
});

// ── Все остальные — с авторизацией ─────────────────────────────────────────
router.use(authMiddleware);

router.get('/',         (_req, res) => res.json(listSubscriptions()));
router.delete('/:id',   (req, res) => { deleteSubscription(req.params.id); res.json({ ok: true }); });
router.get('/template', (_req, res) => res.json({ template: getTemplate(), default: DEFAULT_TEMPLATE }));

const templateSchema = z.object({ template: z.string().min(1).max(1_000_000) });
router.post('/template', validateBody(templateSchema), (req: Request, res: Response) => {
  saveTemplate(req.body.template);
  res.json({ ok: true });
});

router.post('/template/reset', (_req, res) => {
  saveTemplate(DEFAULT_TEMPLATE);
  res.json({ ok: true, template: DEFAULT_TEMPLATE });
});

router.post('/regenerate', (_req, res) => {
  const count = regenerateAllSubscriptions();
  res.json({ ok: true, updated: count });
});

router.get('/settings', (_req, res) => res.json({ vpsHost: getVpsHost() }));

const settingsSchema = z.object({ vpsHost: z.string().max(255).optional() });
router.post('/settings', validateBody(settingsSchema), (req: Request, res: Response) => {
  const { vpsHost } = req.body as { vpsHost?: string };
  if (vpsHost !== undefined) saveVpsHost(vpsHost);
  res.json({ ok: true });
});

export default router;
