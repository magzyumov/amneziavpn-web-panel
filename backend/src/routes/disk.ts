// Место на диске VPS: постоянный список того, что растёт, и кнопки очистки.
// Команды здесь выполняются под sudo и удаляют файлы — только админ.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../services/db.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { auditTarget, auditDetails } from '../middleware/audit.js';
import { validateBody } from '../middleware/validate.js';
import { collectDisk, cleanDiskItem } from '../services/disk.js';
import type { Server } from '../types.js';

const router = Router();
router.use(authMiddleware);
router.use(requireAdmin);

function loadServer(req: Request, res: Response): Server | null {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
  if (!server) { res.status(404).json({ error: 'Server not found' }); return null; }
  auditTarget(req, { id: server.id, name: server.name });
  return server;
}

// GET /api/disk/:serverId
router.get('/:serverId', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  res.json(await collectDisk(server));
});

// POST /api/disk/:serverId/clean
router.post('/:serverId/clean',
  validateBody(z.object({ item: z.string().min(1).max(64) })),
  async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    auditDetails(req, { item: req.body.item });
    res.json(await cleanDiskItem(server, req.body.item));
  });

export default router;
