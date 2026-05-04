import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, query, queryOne, run } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection, disconnect } from '../services/ssh.js';
import { listAmneziaContainers, ensureDocker } from '../services/protocols.js';

const router = Router();
router.use(authMiddleware);

// GET /api/servers
router.get('/', async (req, res) => {
  await getDb();
  const servers = query('SELECT id, name, host, port, username, auth_type, created_at FROM servers');
  res.json(servers);
});

// POST /api/servers
router.post('/', async (req, res) => {
  await getDb();
  const { name, host, port = 22, username, auth_type = 'password', password, private_key } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'name, host, username required' });

  const id = uuidv4();
  run(
    'INSERT INTO servers (id, name, host, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, host, port, username, auth_type, password || null, private_key || null]
  );
  res.json({ id, name, host, port, username, auth_type });
});

// DELETE /api/servers/:id
router.delete('/:id', async (req, res) => {
  await getDb();
  disconnect(req.params.id);
  run('DELETE FROM servers WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// POST /api/servers/:id/test
router.post('/:id/test', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const result = await testConnection(server);
  res.json(result);
});

// POST /api/servers/:id/ensure-docker
router.post('/:id/ensure-docker', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  await ensureDocker(server);
  res.json({ ok: true });
});

// GET /api/servers/:id/containers
router.get('/:id/containers', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const containers = await listAmneziaContainers(server);
  res.json(containers);
});

export default router;
