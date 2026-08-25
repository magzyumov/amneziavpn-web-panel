import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { encrypt } from '../services/crypto.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { revokeProtocolGrants } from '../services/access.js';
import { cacheDnsStatus } from '../services/serverProbe.js';
import { auditTarget, auditDetails } from '../middleware/audit.js';
import { validateBody } from '../middleware/validate.js';
import { testConnection, disconnect } from '../services/ssh.js';
import { listAmneziaContainers, ensureDocker, updateAndRebootHost, scanExistingProtocols, installDns, removeDns, isDnsRunning, getDnsDrift } from '../services/protocols/index.js';
import { assertContainerName, assertPort } from '../services/shell.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';
import { logger } from '../services/logger.js';
import type { Server, Protocol, ProtocolType } from '../types.js';

const router = Router();
// Серверы = SSH-доступ к боевым VPS: креды, установка Docker, выполнение команд.
// Обычному пользователю здесь не нужно ничего, включая чтение списка.
router.use(authMiddleware);
router.use(requireAdmin);

// Загрузка сервера по :id + запись его имени в журнал действий: в записи
// «удалил сервер» id ничего не говорит, а имя говорит всё.
function loadServer(req: Request, res: Response): Server | null {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) { res.status(404).json({ error: 'Server not found' }); return null; }
  auditTarget(req, { id: server.id, name: server.name });
  return server;
}

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
  type: z.enum(['awg2', 'wireguard', 'xray', 'telemt']),
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
  auditTarget(req, { id, name });
  // Хост и способ входа — да, пароль и ключ — никогда.
  auditDetails(req, { host, port, username, authType: auth_type });
  res.json({ id, name, host, port, username, auth_type });
});

// PUT /api/servers/:id
router.put('/:id', validateBody(serverSchema), (req: Request, res: Response) => {
  const server = loadServer(req, res);
  if (!server) return;

  const { name, host, port, username, auth_type, password, private_key } = req.body;

  // Пустое поле = «не менять». Форма редактирования НИКОГДА не подставляет
  // текущий секрет в input (его незачем отдавать в браузер), поэтому раньше
  // сохранение с нетронутым полем пароля затирало креды: панель мгновенно
  // теряла доступ к серверу, а причина выглядела как «SSH перестал пускать».
  const keep = (incoming: unknown, current: string | null | undefined): string | null =>
    typeof incoming === 'string' && incoming.length > 0
      ? (encrypt(incoming) ?? null)
      : (current ?? null);

  run(
    'UPDATE servers SET name=?, host=?, port=?, username=?, auth_type=?, password=?, private_key=? WHERE id=?',
    [name, host, port ?? server.port, username, auth_type ?? server.auth_type,
     keep(password, server.password), keep(private_key, server.private_key), req.params.id]
  );

  // Сбрасываем SSH-соединение чтобы подключиться с новыми данными
  disconnect(req.params.id);

  res.json({ id: req.params.id, name, host, port: port ?? server.port, username, auth_type: auth_type ?? server.auth_type });
});

// DELETE /api/servers/:id
router.delete('/:id', (req, res) => {
  // Имя нужно снять ДО удаления — потом его взять будет неоткуда.
  const existing = queryOne<Server>('SELECT id, name FROM servers WHERE id = ?', [req.params.id]);
  if (existing) auditTarget(req, { id: existing.id, name: existing.name });

  disconnect(req.params.id);
  // Выдачи протоколов этого сервера — вручную: foreign_keys в базе выключены,
  // иначе в user_protocols остались бы строки на несуществующие протоколы.
  const affected = query<{ id: string }>('SELECT id FROM protocols WHERE server_id = ?', [req.params.id]);
  auditDetails(req, { protocols: affected.length });
  for (const p of affected) {
    revokeProtocolGrants(p.id);
  }
  run('DELETE FROM servers WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;

  const result = await testConnection(server);
  res.json(result);
});

router.post('/:id/ensure-docker', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;

  await ensureDocker(server);
  res.json({ ok: true });
});

// Обновление пакетов ОС + перезагрузка. Запрос висит всё время apt-get upgrade
// (минуты), поэтому фронт показывает прогресс сам, а не ждёт быстрый ответ.
router.post('/:id/update-system', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;

  const output = await updateAndRebootHost(server);
  res.json({ ok: true, output });
});

// AmneziaDNS — серверный DNS-резолвер (защита от DNS-leak). Один на сервер.
router.get('/:id/dns', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  const installed = await isDnsRunning(server);
  // Кэшируем для дашборда — он про DNS знает, но по SSH за этим не ходит.
  cacheDnsStatus(server.id, installed);
  // Дрейф считаем только у запущенного: у отсутствующего контейнера метки пустые
  // и сравнивать не с чем.
  const drift = installed ? await getDnsDrift(server) : null;
  res.json({ installed, drift });
});

router.post('/:id/dns', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  const result = await installDns(server);
  cacheDnsStatus(server.id, true);
  res.json({ ok: true, ...result });
});

router.delete('/:id/dns', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;
  await removeDns(server);
  cacheDnsStatus(server.id, false);
  res.json({ ok: true });
});

router.get('/:id/containers', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;

  const containers = await listAmneziaContainers(server);
  res.json(containers);
});

// Сканирует сервер на наличие уже установленных протоколов Amnezia
router.post('/:id/scan-protocols', async (req, res) => {
  const server = loadServer(req, res);
  if (!server) return;

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
  const server = loadServer(req, res);
  if (!server) return;

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

  // name не пишем — см. комментарий в routes/protocols.ts: заголовок выводится
  // из type + config, а снимок имени в БД только вносил путаницу.
  const protocolId = uuidv4();
  run(
    'INSERT INTO protocols (id, server_id, type, name, port, container_name, status, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [protocolId, server.id, type, null, port ?? null, containerName, 'running', JSON.stringify(config || {})]
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

    // cl.clientId — это pubkey для AWG/WG (берётся прямо из clientsTable
    // в контейнере) и UUID для Xray.
    run(
      'INSERT INTO clients (id, protocol_id, server_id, name, config, peer_id) VALUES (?, ?, ?, ?, ?, ?)',
      [clientId, protocolId, server.id, cl.name, clientConfig, cl.clientId]
    );
    importedClients++;
  }

  // Действие про протокол, а не про сервер: перебиваем цель, выставленную
  // loadServer, и оставляем имя сервера в подробностях.
  auditTarget(req, { id: protocolId, name: `${type} на ${server.name}`, type: 'protocol' });
  auditDetails(req, { type, container: containerName, importedClients });

  // Как и при установке — строка целиком в форме GET /protocols/server/:serverId
  // (config объектом, а не строкой), плюс счётчик для окна сканирования.
  const row = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [protocolId]);
  res.json({ ...row, config: row?.config ? JSON.parse(row.config) : {}, importedClients });
});

export default router;
