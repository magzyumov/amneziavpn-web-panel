import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
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

// ── Публичный endpoint — отдаёт YAML по slug (без авторизации) ──────────────
// GET /sub/:slug
router.get('/sub/:slug', subLimiter, async (req, res) => {
  await getDb();
  const sub = getSubscriptionBySlug(req.params.slug);
  if (!sub) return res.status(404).send('# Subscription not found\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${sub.client_name}.yaml"`);
  res.send(sub.yaml_content);
});

// ── Все остальные — с авторизацией ─────────────────────────────────────────
router.use(authMiddleware);

// GET /api/subscriptions — список подписок
router.get('/', async (req, res) => {
  await getDb();
  res.json(listSubscriptions());
});

// DELETE /api/subscriptions/:id
router.delete('/:id', async (req, res) => {
  await getDb();
  deleteSubscription(req.params.id);
  res.json({ ok: true });
});

// GET /api/subscriptions/template — текущий шаблон
router.get('/template', async (req, res) => {
  await getDb();
  res.json({ template: getTemplate(), default: DEFAULT_TEMPLATE });
});

// POST /api/subscriptions/template — сохранить шаблон
router.post('/template', async (req, res) => {
  await getDb();
  const { template } = req.body;
  if (!template) return res.status(400).json({ error: 'template required' });
  saveTemplate(template);
  res.json({ ok: true });
});

// POST /api/subscriptions/template/reset — сбросить к дефолту
router.post('/template/reset', async (req, res) => {
  await getDb();
  saveTemplate(DEFAULT_TEMPLATE);
  res.json({ ok: true, template: DEFAULT_TEMPLATE });
});

// POST /api/subscriptions/regenerate — пересгенерировать все подписки из шаблона
router.post('/regenerate', async (req, res) => {
  await getDb();
  const count = regenerateAllSubscriptions();
  res.json({ ok: true, updated: count });
});

// GET /api/subscriptions/settings — настройки (vps_host)
router.get('/settings', async (req, res) => {
  await getDb();
  res.json({ vpsHost: getVpsHost() });
});

// POST /api/subscriptions/settings — сохранить настройки
router.post('/settings', async (req, res) => {
  await getDb();
  const { vpsHost } = req.body;
  if (vpsHost !== undefined) saveVpsHost(vpsHost);
  res.json({ ok: true });
});

export default router;
