// Сводка для главной страницы. Только чтение и только из базы — SSH здесь нет
// намеренно, см. комментарий в services/dashboard.ts.
import { Router } from 'express';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { buildDashboard } from '../services/dashboard.js';
import { probeAllServers } from '../services/serverProbe.js';

const router = Router();
router.use(authMiddleware);
router.use(requireAdmin);

router.get('/', (_req, res) => res.json(buildDashboard()));

// POST /api/dashboard/probe — единственное место, где дашборд ходит по SSH, и
// только по явной команде: снимает аптайм, нагрузку, память, диск и статус
// AmneziaDNS с каждого сервера. Возвращает уже обновлённую сводку.
router.post('/probe', async (_req, res) => {
  const { probed } = await probeAllServers();
  res.json({ probed, summary: buildDashboard() });
});

export default router;
