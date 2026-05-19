import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { encrypt } from '../services/crypto.js';
import { authMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { testConnection, disconnect } from '../services/ssh.js';
import { listAmneziaContainers, ensureDocker, scanExistingProtocols } from '../services/protocols/index.js';
import { assertContainerName, assertPort } from '../services/shell.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';
import { logger } from '../services/logger.js';
import type { Server, ProtocolType } from '../types.js';

const router = Router();
router.use(authMiddleware);

const serverSchema = z.object({
  name: z.string().min(1).max(128),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1).max(128),
  auth_type: z.enum(['password', 'key']).optional().default('password'),
  password: z.string().optional().nullable(),
  private_key: z.string().optional().nullable(),
});

const importSchema = z.object({
  type: z.enum(['awg2', 'wireguard', 'xray']),
  containerName: z.string().min(1).max(128),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  clients: z.array(z.object({
    clientId: z.string(),
    name: z.string(),
  })).optional().default([]),
});

// GET /api/servers
router.get('/', (_req, res) => {
  const servers = query<Server>('SELECT id, name, host, port, username, auth_type, created_at FROM servers');
  res.json(servers);
});

// POST /api/servers
router.post('/', validateBody(serverSchema), (req: Request, res: Response) => {
  const { name, host, port, username, auth_type, password, private_key } = req.body;
  const id = uuidv4();
  run(
    'INSERT INTO servers (id, name, host, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, host, port, username, auth_type, encrypt(password) || null, encrypt(private_key) || null]
  );
  res.json({ id, name, host, port, username, auth_type });
});

// PUT /api/servers/:id
router.put('/:id', validateBody(serverSchema), (req: Request, res: Response) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { name, host, port, username, auth_type, password, private_key } = req.body;
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
router.delete('/:id', (req, res) => {
  disconnect(req.params.id);
  run('DELETE FROM servers WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const result = await testConnection(server);
  res.json(result);
});

router.post('/:id/ensure-docker', async (req, res) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  await ensureDocker(server);
  res.json({ ok: true });
});

router.get('/:id/containers', async (req, res) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const containers = await listAmneziaContainers(server);
  res.json(containers);
});

// Сканирует сервер на наличие уже установленных протоколов Amnezia
router.post('/:id/scan-protocols', async (req, res) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const found = await scanExistingProtocols(server);
    res.json({ found });
  } catch (e) {
    logger.error({ err: e }, 'scan-protocols failed');
    res.status(500).json({ error: 'Failed to scan protocols' });
  }
});

// Импортирует найденный протокол в БД (после сканирования) и создаёт записи клиентов
router.post('/:id/import-protocol', validateBody(importSchema), (req: Request, res: Response) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { type, containerName, port, config, clients } = req.body as {
    type: ProtocolType; containerName: string; port: number | null | undefined;
    config?: Record<string, unknown>; clients: Array<{ clientId: string; name: string }>;
  };
  // Дополнительный shell-safety guard (поверх zod).
  try {
    assertContainerName(containerName);
    if (port != null) assertPort(port);
  } catch (e) { return res.status(400).json({ error: (e as Error).message }); }

  const existing = queryOne<{ id: string }>('SELECT id FROM protocols WHERE server_id = ? AND container_name = ?', [server.id, containerName]);
  if (existing) return res.status(409).json({ error: 'Protocol already imported', id: existing.id });

  const names: Record<ProtocolType, string> = { awg2: 'AmneziaWG 2.0', wireguard: 'WireGuard', xray: 'Xray VLESS Reality' };
  const protocolId = uuidv4();
  run(
    'INSERT INTO protocols (id, server_id, type, name, port, container_name, status, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [protocolId, server.id, type, names[type] || type, port ?? null, containerName, 'running', JSON.stringify(config || {})]
  );

  let importedClients = 0;
  const vpsHost = getVpsHost() || server.host;

  for (const cl of clients) {
    if (!cl.clientId || !cl.name) continue;
    const clientId = uuidv4();
    let clientConfig: string | null = null;

    if (type === 'xray' && config) {
      const { port: xrayPort, publicKey, shortId, sni } = config as any;
      clientConfig = `vless://${cl.clientId}@${server.host}:${xrayPort}?type=tcp&security=reality&pbk=${publicKey}&fp=chrome&sni=${sni}&sid=${shortId}&flow=xtls-rprx-vision#${encodeURIComponent(cl.name)}`;
      try {
        createSubscription({ clientId, clientName: cl.name, serverHost: vpsHost, vlessUrl: clientConfig });
      } catch (e) {
        logger.error({ err: e }, '[import-protocol] subscription error');
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
