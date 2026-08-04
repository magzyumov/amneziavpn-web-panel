// Сводка для главной страницы. Только чтение и только из базы — SSH здесь нет
// намеренно, см. комментарий в services/dashboard.ts.
import { Router } from 'express';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { buildDashboard } from '../services/dashboard.js';

const router = Router();
router.use(authMiddleware);
router.use(requireAdmin);

router.get('/', (_req, res) => res.json(buildDashboard()));

export default router;
