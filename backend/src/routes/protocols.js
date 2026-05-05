import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, query, queryOne, run } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  installAWG2, installXray, installWireGuard,
  getContainerStatus, startContainer, stopContainer,
  removeContainer, getContainerLogs, PROTOCOLS,
} from '../services/protocols.js';

const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => res.json(PROTOCOLS));

router.get('/server/:serverId', async (req, res) => {
  await getDb();
  const protocols = query('SELECT * FROM protocols WHERE server_id = ?', [req.params.serverId]);
  res.json(protocols.map(p => ({ ...p, config: p.config ? JSON.parse(p.config) : {} })));
});

router.post('/server/:serverId', async (req, res) => {
  await getDb();
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { type, options = {} } = req.body;

  let result;
  if      (type === 'awg2')      result = await installAWG2(server, options);
  else if (type === 'xray')      result = await installXray(server, options);
  else if (type === 'wireguard') result = await installWireGuard(server, options);
  else return res.status(400).json({ error: `Unknown protocol: ${type}` });

  const id = uuidv4();
  run(
    'INSERT INTO protocols (id, server_id, type, name, container_name, port, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, server.id, type, PROTOCOLS[type]?.name || type, result.containerName, result.port, JSON.stringify(result.config), 'running']
  );

  res.json({ id, type, containerName: result.containerName, port: result.port, config: result.config });
});

router.delete('/:id', async (req, res) => {
  await getDb();
  const p = queryOne('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  await removeContainer(server, p.container_name);
  run('DELETE FROM clients WHERE protocol_id = ?', [p.id]);
  run('DELETE FROM protocols WHERE id = ?', [p.id]);
  res.json({ ok: true });
});

router.post('/:id/start', async (req, res) => {
  await getDb();
  const p = queryOne('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  await startContainer(server, p.container_name);
  run("UPDATE protocols SET status = 'running' WHERE id = ?", [p.id]);
  res.json({ ok: true });
});

router.post('/:id/stop', async (req, res) => {
  await getDb();
  const p = queryOne('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  await stopContainer(server, p.container_name);
  run("UPDATE protocols SET status = 'stopped' WHERE id = ?", [p.id]);
  res.json({ ok: true });
});

router.get('/:id/status', async (req, res) => {
  await getDb();
  const p = queryOne('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  const status = await getContainerStatus(server, p.container_name);
  run('UPDATE protocols SET status = ? WHERE id = ?', [status, p.id]);
  res.json({ status });
});

router.get('/:id/logs', async (req, res) => {
  await getDb();
  const p = queryOne('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  const logs = await getContainerLogs(server, p.container_name, req.query.lines || 100);
  res.json({ logs });
});

export default router;
