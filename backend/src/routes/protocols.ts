import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { revokeProtocolGrants } from '../services/access.js';
import { cacheDrift } from '../services/serverProbe.js';
import { auditTarget, auditDetails } from '../middleware/audit.js';
import { validateBody } from '../middleware/validate.js';
import {
  installAWG2, installXray, installWireGuard, installTelemt,
  getContainerStatus, getContainersHealth, startContainer, stopContainer,
  removeContainer, getContainerLogs, PROTOCOLS,
  isXrayStatsEnabled, enableXrayStats,
} from '../services/protocols/index.js';
import { prepareHost } from '../services/protocols/common.js';
import { getProtocolsDrift, type ProtocolDrift } from '../services/protocols/drift.js';
import { logger } from '../services/logger.js';
import { shInt } from '../services/shell.js';
import type { Server, Protocol, ProtocolType } from '../types.js';

const router = Router();
// Весь роутер — административный: здесь ставят и сносят контейнеры, читают логи
// и статусы. Обычному пользователю знать о протоколах нужно ровно столько,
// сколько отдаёт GET /api/clients/available-protocols.
router.use(authMiddleware);
router.use(requireAdmin);

const installSchema = z.object({
  type: z.enum(['awg2', 'wireguard', 'xray', 'telemt']),
  options: z.record(z.unknown()).optional().default({}),
});

router.get('/', (_req, res) => res.json(PROTOCOLS));

router.get('/server/:serverId', (req, res) => {
  const protocols = query<Protocol>('SELECT * FROM protocols WHERE server_id = ?', [req.params.serverId]);
  res.json(protocols.map(p => ({ ...p, config: p.config ? JSON.parse(p.config) : {} })));
});

// Реальные статусы всех контейнеров за один SSH-вызов
router.get('/server/:serverId/health', async (req, res) => {
  const protocols = query<Pick<Protocol, 'id' | 'container_name' | 'type' | 'port'>>(
    'SELECT id, container_name, type, port FROM protocols WHERE server_id = ?', [req.params.serverId]);
  if (!protocols.length) return res.json({ statuses: {}, drift: {} });

  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const statusMap = await getContainersHealth(server, protocols.map(p => p.container_name));

  const statuses: Record<string, string> = {};
  for (const p of protocols) {
    const status = statusMap[p.container_name] ?? 'not_found';
    run('UPDATE protocols SET status = ? WHERE id = ?', [status, p.id]);
    statuses[p.id] = status;
  }

  // Расхождение с тем, что панель поставила бы сейчас. Не ошибка — подсказка,
  // что протокол стоит переустановить. Падение проверки не должно ронять health.
  let drift: Record<string, ProtocolDrift> = {};
  try {
    drift = await getProtocolsDrift(server, protocols.map(p => ({
      id: p.id, type: p.type, containerName: p.container_name, port: p.port,
    })));
    // Кэшируем: дашборд показывает дрейф, но сам по SSH не ходит.
    for (const [id, d] of Object.entries(drift)) cacheDrift(id, d);
  } catch (e) {
    logger.warn({ err: e }, 'drift check failed');
  }

  res.json({ statuses, drift });
});

router.post('/server/:serverId', validateBody(installSchema), async (req: Request, res: Response) => {
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { type, options } = req.body as { type: ProtocolType; options: Record<string, any> };

  // Подготовка хоста (ip_forward + сеть amnezia-dns-net) — идемпотентно, один раз.
  await prepareHost(server);

  let result;
  if      (type === 'awg2')      result = await installAWG2(server, options);
  else if (type === 'xray')      result = await installXray(server, options);
  else if (type === 'telemt')    result = await installTelemt(server, options);
  else                            result = await installWireGuard(server, options);

  const id = uuidv4();
  // name не пишем: это был снимок имени на момент установки, он не обновлялся, и
  // после переименования протокола карточки показывали устаревшее название.
  // Заголовок выводится из type + config на фронте (frontend/src/protocols.ts).
  run(
    'INSERT INTO protocols (id, server_id, type, name, container_name, port, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, server.id, type, null, result.containerName, result.port, JSON.stringify(result.config), 'running']
  );

  auditTarget(req, { id, name: `${type} на ${server.name}` });
  auditDetails(req, { type, port: result.port, container: result.containerName });

  // Отдаём строку целиком и в том же виде, что и GET /server/:serverId — фронт
  // кладёт ответ прямо в список протоколов, и на усечённой форме (без name,
  // container_name, status) карточка оставалась пустой до перезагрузки страницы.
  const row = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [id]);
  res.json({ ...row, config: row?.config ? JSON.parse(row.config) : {} });
});

router.delete('/:id', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  auditTarget(req, { id: p.id, name: `${p.type} на ${server.name}` });
  auditDetails(req, { clients: queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM clients WHERE protocol_id = ?', [p.id])?.n ?? 0 });
  await removeContainer(server, p.container_name);
  run('DELETE FROM clients WHERE protocol_id = ?', [p.id]);
  revokeProtocolGrants(p.id);
  run('DELETE FROM protocols WHERE id = ?', [p.id]);
  res.json({ ok: true });
});

router.post('/:id/start', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  auditTarget(req, { id: p.id, name: `${p.type} на ${server.name}` });
  await startContainer(server, p.container_name);
  run("UPDATE protocols SET status = 'running' WHERE id = ?", [p.id]);
  res.json({ ok: true });
});

router.post('/:id/stop', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  auditTarget(req, { id: p.id, name: `${p.type} на ${server.name}` });
  await stopContainer(server, p.container_name);
  run("UPDATE protocols SET status = 'stopped' WHERE id = ?", [p.id]);
  res.json({ ok: true });
});

router.get('/:id/status', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const status = await getContainerStatus(server, p.container_name);
  run('UPDATE protocols SET status = ? WHERE id = ?', [status, p.id]);
  res.json({ status });
});

// Возвращает { statsEnabled } — для UI чтобы показать или скрыть "Enable stats".
// AWG/WG всегда true (статистика идёт из kernel-модуля бесплатно). Для Xray
// читаем server.json и проверяем наличие "stats"/"api" блоков.
router.get('/:id/stats-status', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });

  if (p.type !== 'xray') return res.json({ statsEnabled: true });

  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const enabled = await isXrayStatsEnabled(server, p.container_name);
  res.json({ statsEnabled: enabled });
});

// Включает stats на существующем Xray-протоколе (патчит server.json через jq
// и рестартит контейнер). Для не-Xray возвращает 400 — там и так включено.
router.post('/:id/enable-stats', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.type !== 'xray') return res.status(400).json({ error: 'enable-stats is only needed for Xray' });

  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  auditTarget(req, { id: p.id, name: `${p.type} на ${server.name}` });
  await enableXrayStats(server, p.container_name);
  res.json({ ok: true });
});

router.get('/:id/logs', async (req, res) => {
  const p = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [p.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  let lines: number;
  try { lines = shInt(req.query.lines ?? 100, { min: 1, max: 10000, label: 'lines' }); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  const logs = await getContainerLogs(server, p.container_name, lines);
  res.json({ logs });
});

export default router;
