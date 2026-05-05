import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, query, queryOne, run } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection, disconnect } from '../services/ssh.js';
import { listAmneziaContainers, ensureDocker, scanExistingProtocols } from '../services/protocols.js';

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

// POST /api/servers/:id/scan-protocols
// Сканирует сервер на наличие уже установленных протоколов Amnezia
router.post('/:id/scan-protocols', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const found = await scanExistingProtocols(server);
    res.json({ found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/import-protocol
// Импортирует найденный протокол в БД (после сканирования)
router.post('/:id/import-protocol', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { type, containerName, port, config } = req.body;
  if (!type || !containerName) return res.status(400).json({ error: 'type and containerName required' });

  // Проверяем не импортирован ли уже этот контейнер
  const existing = queryOne('SELECT id FROM protocols WHERE server_id = ? AND container_name = ?', [server.id, containerName]);
  if (existing) return res.status(409).json({ error: 'Protocol already imported', id: existing.id });

  const names = { awg2: 'AmneziaWG 2.0', wireguard: 'WireGuard', xray: 'Xray VLESS Reality' };
  const id = uuidv4();
  run(
    'INSERT INTO protocols (id, server_id, type, name, port, container_name, status, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, server.id, type, names[type] || type, port, containerName, 'running', JSON.stringify(config || {})]
  );

  res.json({ id, type, name: names[type] || type, port, containerName, status: 'running', config: JSON.stringify(config || {}) });
});

export default router;
