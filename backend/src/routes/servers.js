import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, run } from '../services/db.js';
import { encrypt } from '../services/crypto.js';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection, disconnect } from '../services/ssh.js';
import { listAmneziaContainers, ensureDocker, scanExistingProtocols } from '../services/protocols.js';
import { assertContainerName, assertPort } from '../services/shell.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';

const router = Router();
router.use(authMiddleware);

// GET /api/servers
router.get('/', async (req, res) => {
  const servers = query('SELECT id, name, host, port, username, auth_type, created_at FROM servers');
  res.json(servers);
});

// POST /api/servers
router.post('/', async (req, res) => {
  const { name, host, port = 22, username, auth_type = 'password', password, private_key } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'name, host, username required' });

  const id = uuidv4();
  run(
    'INSERT INTO servers (id, name, host, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, host, port, username, auth_type, encrypt(password) || null, encrypt(private_key) || null]
  );
  res.json({ id, name, host, port, username, auth_type });
});

// PUT /api/servers/:id
router.put('/:id', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { name, host, port, username, auth_type, password, private_key } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'name, host, username required' });

  run(
    'UPDATE servers SET name=?, host=?, port=?, username=?, auth_type=?, password=?, private_key=? WHERE id=?',
    [name, host, port ?? server.port, username, auth_type ?? server.auth_type,
     encrypt(password) || null, encrypt(private_key) || null, req.params.id]
  );

  // Сбрасываем SSH-соединение чтобы подключиться с новыми данными
  disconnect(req.params.id);

  res.json({ id: req.params.id, name, host, port: port ?? server.port, username, auth_type: auth_type ?? server.auth_type });
});

// DELETE /api/servers/:id
router.delete('/:id', async (req, res) => {
  disconnect(req.params.id);
  run('DELETE FROM servers WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// POST /api/servers/:id/test
router.post('/:id/test', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const result = await testConnection(server);
  res.json(result);
});

// POST /api/servers/:id/ensure-docker
router.post('/:id/ensure-docker', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  await ensureDocker(server);
  res.json({ ok: true });
});

// GET /api/servers/:id/containers
router.get('/:id/containers', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const containers = await listAmneziaContainers(server);
  res.json(containers);
});

// POST /api/servers/:id/scan-protocols
// Сканирует сервер на наличие уже установленных протоколов Amnezia
router.post('/:id/scan-protocols', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const found = await scanExistingProtocols(server);
    res.json({ found });
  } catch (e) {
    console.error('[scan-protocols]', e.stack || e.message);
    res.status(500).json({ error: 'Failed to scan protocols' });
  }
});

// POST /api/servers/:id/import-protocol
// Импортирует найденный протокол в БД (после сканирования) и создаёт записи клиентов
router.post('/:id/import-protocol', async (req, res) => {
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { type, containerName, port, config, clients = [] } = req.body;
  if (!type || !containerName) return res.status(400).json({ error: 'type and containerName required' });
  if (!['awg2', 'wireguard', 'xray'].includes(type)) return res.status(400).json({ error: 'Invalid protocol type' });
  try {
    assertContainerName(containerName);
    if (port != null) assertPort(port);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // Проверяем не импортирован ли уже этот контейнер
  const existing = queryOne('SELECT id FROM protocols WHERE server_id = ? AND container_name = ?', [server.id, containerName]);
  if (existing) return res.status(409).json({ error: 'Protocol already imported', id: existing.id });

  const names = { awg2: 'AmneziaWG 2.0', wireguard: 'WireGuard', xray: 'Xray VLESS Reality' };
  const protocolId = uuidv4();
  run(
    'INSERT INTO protocols (id, server_id, type, name, port, container_name, status, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [protocolId, server.id, type, names[type] || type, port, containerName, 'running', JSON.stringify(config || {})]
  );

  // Импортируем клиентов
  let importedClients = 0;
  const vpsHost = getVpsHost() || server.host;

  for (const cl of clients) {
    if (!cl.clientId || !cl.name) continue;
    const clientId = uuidv4();
    let clientConfig = null;

    if (type === 'xray' && config) {
      // Для Xray восстанавливаем VLESS URI из UUID + серверного конфига
      const { port: xrayPort, publicKey, shortId, sni } = config;
      clientConfig = `vless://${cl.clientId}@${server.host}:${xrayPort}?type=tcp&security=reality&pbk=${publicKey}&fp=chrome&sni=${sni}&sid=${shortId}&flow=xtls-rprx-vision#${encodeURIComponent(cl.name)}`;
      try {
        createSubscription({ clientId, clientName: cl.name, serverHost: vpsHost, vlessUrl: clientConfig });
      } catch (e) {
        console.error('[import-protocol] subscription error:', e.message);
      }
    }
    // AWG/WireGuard: clientConfig остаётся null — приватный ключ клиента не хранится на сервере

    run(
      'INSERT INTO clients (id, protocol_id, server_id, name, config) VALUES (?, ?, ?, ?, ?)',
      [clientId, protocolId, server.id, cl.name, clientConfig]
    );
    importedClients++;
  }

  res.json({
    id: protocolId,
    type,
    name: names[type] || type,
    port,
    containerName,
    status: 'running',
    config: JSON.stringify(config || {}),
    importedClients,
  });
});

export default router;
