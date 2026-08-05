import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  canAccessClient, canUseProtocol, quotaReached, countUserClients,
  accessibleProtocols, isAdmin,
} from '../services/access.js';
import { validateBody } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { auditTarget, auditDetails } from '../middleware/audit.js';
import {
  addAWG2Client, addXrayClient, addWireGuardClient, addTelemtClient,
} from '../services/protocols/index.js';
import { loadClientContext, revokePeer, purgeClientRows } from '../services/clientLifecycle.js';
import { usedToday, enforceLimitsForClient } from '../services/limits.js';
import { clientTrafficSince, lastHandshakes, isOnline } from '../services/dashboard.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';
import { buildAmneziaExportJson, buildVpnUri, buildChunkedAmneziaQr } from '../services/amneziaExport.js';
import { extractPeerId } from '../services/peerId.js';
import { sumTraffic, downsample, rateSeries } from '../services/statsAggregate.js';
import { logger } from '../services/logger.js';
import type { Server, Protocol, Client, ProtocolType } from '../types.js';

const router = Router();

// ─── Утилиты ─────────────────────────────────────────────────────────────────

const createClientSchema = z.object({
  protocolId: z.string().min(1),
  name: z.string().min(1).max(128),
  // Лимиты задаёт админ. Обычному пользователю их подставляют из его учётки:
  // ограничение, которое можно выбрать самому, ничего не ограничивает.
  expiresInDays: z.coerce.number().int().min(0).max(3650).optional(),
  dailyLimitMb: z.coerce.number().int().min(0).max(1024 * 1024).optional(),
});

const limitsSchema = z.object({
  expiresInDays: z.coerce.number().int().min(0).max(3650).optional(),
  dailyLimitMb: z.coerce.number().int().min(0).max(1024 * 1024).optional(),
});

const MB = 1024 * 1024;

// Поля лимитов в том виде, в каком их ждёт фронт: срок, суточный лимит,
// израсходованное за сегодня и признак приостановки.
//
// used_today считаем всегда, а не только при заданном лимите: расход за сутки
// показывается и сам по себе (личная сводка пользователя), и раньше клиент без
// лимита отдавал бы ноль вместо реальной цифры. Запрос идёт по первичному ключу
// client_stats (client_id, ts), так что это две быстрые выборки на клиента.
function limitFields(client: Client): Record<string, unknown> {
  return {
    expires_at: client.expires_at ?? null,
    daily_limit_bytes: client.daily_limit_bytes ?? 0,
    suspended_at: client.suspended_at ?? null,
    used_today: usedToday(client.id),
  };
}

// ЕДИНСТВЕННЫЙ способ достать клиента по id в этом роутере. Раньше каждый
// хендлер делал свой SELECT, и с появлением обычных пользователей любая
// забытая проверка означала бы выдачу чужого VPN-конфига. Отдаём 404, а не 403:
// пользователю незачем знать, что такой клиент вообще существует.
function loadClient(req: Request, res: Response): Client | null {
  const client = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client || !canAccessClient(client, req.user!)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  // Имя в журнал: «скачал конфиг iPhone» читается, «скачал конфиг 7fb860f8…» нет.
  auditTarget(req, { id: client.id, name: client.name });
  return client;
}

// ─── Всё ниже — только для авторизованных ────────────────────────────────────
router.use(authMiddleware);

// ─── Endpoints скачивания конфигов (auth через httpOnly cookie) ──────────────

// GET /api/clients/:id/config — скачать оригинальный .conf
router.get('/:id/config', (req: Request, res: Response) => {
  const client = loadClient(req, res);
  if (!client) return;
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = (protocol?.type === 'xray' || protocol?.type === 'telemt') ? 'txt' : 'conf';
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/config-amnezia — скачать Amnezia JSON (.json файл)
router.get('/:id/config-amnezia', (req: Request, res: Response) => {
  const client = loadClient(req, res);
  if (!client) return;
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [client.server_id]);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found' });
  const amneziaJson = buildAmneziaExportJson(client, protocol, server);
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}_amnezia.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(amneziaJson);
});

// GET /api/clients/available-protocols — на чём текущий пользователь может
// завести себе клиента. Админ видит все протоколы, обычный юзер — только
// выданные ему администратором (user_protocols).
router.get('/available-protocols', (req: Request, res: Response) => {
  res.json(accessibleProtocols(req.user!));
});

// GET /api/clients/mine — свои клиенты со всем, что нужно для карточки:
// лимиты, расход за сегодня и за неделю, онлайн-статус. Пользователь не видит
// сводки по инфраструктуре, но про свои устройства должен знать столько же,
// сколько администратор.
const WEEK_SEC = 7 * 24 * 60 * 60;

router.get('/mine', (req: Request, res: Response) => {
  const clients = query<Client & {
    has_config: number; protocol_type: ProtocolType; protocol_config: string | null; server_name: string;
  }>(`
    SELECT c.id, c.name, c.created_at, (c.config IS NOT NULL) AS has_config,
           c.protocol_id, c.expires_at, c.daily_limit_bytes, c.suspended_at,
           p.type AS protocol_type, p.config AS protocol_config,
           s.name AS server_name
    FROM clients c
    JOIN protocols p ON p.id = c.protocol_id
    JOIN servers s   ON s.id = c.server_id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `, [req.user!.id]);

  const now = Math.floor(Date.now() / 1000);
  const week = clientTrafficSince(now - WEEK_SEC);
  const handshakes = lastHandshakes();

  res.json(clients.map(c => {
    const w = week.get(c.id);
    return {
      ...c,
      protocol_config: c.protocol_config ? JSON.parse(c.protocol_config) : {},
      ...limitFields(c),
      week_rx: w?.rx ?? 0,
      week_tx: w?.tx ?? 0,
      last_handshake: handshakes.get(c.id) ?? null,
      online: isOnline(handshakes.get(c.id), now),
    };
  }));
});

// Список клиентов протокола — карточка протокола на странице сервера.
// Обычный пользователь видит здесь только своих; чужие имена — тоже информация.
router.get('/protocol/:protocolId', (req, res) => {
  if (!canUseProtocol(req.user!, req.params.protocolId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const cols = 'c.id, c.name, c.created_at, (c.config IS NOT NULL) as has_config, c.expires_at, c.daily_limit_bytes, c.suspended_at';
  // Админу дополнительно отдаём владельца: в общем списке протокола иначе не
  // понять, чей это клиент. Обычному пользователю колонка не нужна — там все
  // клиенты его собственные.
  const clients = isAdmin(req.user!)
    ? query<Client & { has_config: number }>(
        `SELECT ${cols}, u.username AS owner_username
           FROM clients c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.protocol_id = ?`, [req.params.protocolId])
    : query<Client & { has_config: number }>(
        `SELECT ${cols} FROM clients c WHERE c.protocol_id = ? AND c.user_id = ?`,
        [req.params.protocolId, req.user!.id]);
  res.json(clients.map(c => ({ ...c, ...limitFields(c) })));
});

router.post('/', validateBody(createClientSchema), async (req: Request, res: Response) => {
  const { protocolId, name, expiresInDays, dailyLimitMb } = req.body as z.infer<typeof createClientSchema>;
  const protocol = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [protocolId]);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found' });

  // Протокол должен быть выдан пользователю администратором. 404, а не 403:
  // существование чужих протоколов — тоже информация.
  if (!canUseProtocol(req.user!, protocolId)) {
    return res.status(404).json({ error: 'Protocol not found' });
  }
  const limit = req.user!.clientLimit;
  if (quotaReached(countUserClients(req.user!.id), req.user!)) {
    return res.status(403).json({ error: `Достигнут лимит клиентов (${limit}). Удалите ненужный или попросите администратора поднять лимит.` });
  }

  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [protocol.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const safeName = name.trim().replace(/[^a-zA-Z0-9_\-А-Яа-яёЁ ]/g, '').trim();
  if (!safeName) return res.status(400).json({ error: 'Invalid client name' });

  // Лимиты. Админ задаёт их прямо в запросе; обычному пользователю они берутся
  // из его учётки — иначе ограничение обходилось бы простым «не указывать».
  const defaults = queryOne<{ default_expiry_days: number; default_daily_limit_mb: number }>(
    'SELECT default_expiry_days, default_daily_limit_mb FROM users WHERE id = ?', [req.user!.id],
  );
  const days = isAdmin(req.user!)
    ? (expiresInDays ?? 0)
    : (defaults?.default_expiry_days ?? 0);
  const limitMb = isAdmin(req.user!)
    ? (dailyLimitMb ?? 0)
    : (defaults?.default_daily_limit_mb ?? 0);

  const expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 24 * 60 * 60 : null;
  const dailyLimitBytes = limitMb > 0 ? limitMb * MB : 0;

  let result;
  if      (protocol.type === 'awg2')      result = await addAWG2Client(server, protocol, safeName);
  else if (protocol.type === 'xray')      result = await addXrayClient(server, protocol, safeName);
  else if (protocol.type === 'wireguard') result = await addWireGuardClient(server, protocol, safeName);
  else if (protocol.type === 'telemt')    result = await addTelemtClient(server, protocol, safeName);
  else return res.status(400).json({ error: `Unsupported protocol: ${protocol.type}` });

  const id = uuidv4();
  const storedConfig = result.configJson
    ? `${result.config}\n---AMNEZIA_JSON---\n${result.configJson}`
    : result.config;
  const peerId = extractPeerId(storedConfig, protocol.type);
  run(`INSERT INTO clients (id, protocol_id, server_id, name, config, peer_id, user_id, expires_at, daily_limit_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, protocolId, server.id, safeName, storedConfig, peerId, req.user!.id, expiresAt, dailyLimitBytes]);

  let subscriptionSlug: string | null = null;
  if (protocol.type === 'xray') {
    try {
      const vpsHost = getVpsHost() || server.host;
      const { slug } = createSubscription({ clientId: id, clientName: safeName, serverHost: vpsHost, vlessUrl: result.config });
      subscriptionSlug = slug;
    } catch (e) { logger.error({ err: e }, 'Failed to create subscription'); }
  }

  auditTarget(req, { id, name: safeName });
  auditDetails(req, {
    protocol: protocol.type, server: server.name,
    expiresInDays: days || null, dailyLimitMb: limitMb || null,
  });

  const created = queryOne<{ created_at: string }>('SELECT created_at FROM clients WHERE id = ?', [id]);
  res.json({
    id, name: safeName, config: result.config, type: result.type, subscriptionSlug,
    has_config: 1, created_at: created?.created_at,
    expires_at: expiresAt, daily_limit_bytes: dailyLimitBytes, suspended_at: null, used_today: 0,
    // Владелец — тот, кто сейчас создаёт клиента. Форма ответа должна совпадать
    // с GET /protocol/:protocolId: фронт кладёт созданного клиента прямо в
    // список, и без этого поля колонка «Created by» показывала прочерк до
    // перезагрузки страницы.
    owner_username: req.user!.username,
  });
});

// PUT /api/clients/:id/limits — срок и суточный лимит. Только админ: смысл
// ограничения в том, что владелец клиента не может его отменить.
router.put('/:id/limits', requireAdmin, validateBody(limitsSchema), async (req: Request, res: Response) => {
  const client = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  auditTarget(req, { id: client.id, name: client.name });

  const { expiresInDays, dailyLimitMb } = req.body as z.infer<typeof limitsSchema>;
  auditDetails(req, {
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    ...(dailyLimitMb !== undefined ? { dailyLimitMb } : {}),
  });

  // Срок отсчитывается от «сейчас», а не от создания: продление на 7 дней
  // означает «ещё неделю с этого момента», это и ожидается от кнопки продления.
  if (expiresInDays !== undefined) {
    const expiresAt = expiresInDays > 0 ? Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60 : null;
    run('UPDATE clients SET expires_at = ? WHERE id = ?', [expiresAt, client.id]);
  }
  if (dailyLimitMb !== undefined) {
    run('UPDATE clients SET daily_limit_bytes = ? WHERE id = ?', [dailyLimitMb > 0 ? dailyLimitMb * MB : 0, client.id]);
  }

  // Сразу приводим клиента к новым лимитам: подняли порог — приостановка
  // снимается тут же, а не через минуту на тике воркера.
  const updated = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [client.id])!;
  try {
    await enforceLimitsForClient(updated);
  } catch (e) {
    logger.error({ err: e, client: client.id }, 'applying new limits failed');
    return res.status(502).json({ error: `Лимиты сохранены, но применить их на сервере не удалось: ${(e as Error).message}` });
  }

  const fresh = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [client.id]);
  // Клиента могло не стать: выставили срок в прошлом — он удалён.
  res.json(fresh ? { id: fresh.id, name: fresh.name, ...limitFields(fresh) } : { deleted: true });
});

// GET /api/clients/:id/qr — QR для оригинального формата (.conf / VLESS URI)
router.get('/:id/qr', async (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  if (!client.config) return res.json({ qr: null, amneziaQr: null, vpnUri: null, noConfig: true });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [client.server_id]);

  const origConfig = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  const origQr = await QRCode.toDataURL(origConfig, { width: 400, margin: 2, errorCorrectionLevel: 'L' });

  let amneziaQrParts: string[] | null = null;
  let vpnUri: string | null = null;
  if (protocol?.type === 'awg2' || protocol?.type === 'wireguard' || protocol?.type === 'xray') {
    try {
      const amneziaJson = buildAmneziaExportJson(client, protocol, server);
      vpnUri = buildVpnUri(amneziaJson);
      amneziaQrParts = await buildChunkedAmneziaQr(amneziaJson);
    } catch (e) {
      logger.error({ err: e }, 'Amnezia QR error');
    }
  }

  const amneziaQr = amneziaQrParts?.[0] ?? null;
  res.json({ qr: origQr, amneziaQr, amneziaQrParts, vpnUri });
});

// GET /api/clients/:id/config-text — текст оригинального конфига
router.get('/:id/config-text', (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  if (!client.config) return res.json({ config: null, vpnUri: null, name: client.name, noConfig: true });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [client.server_id]);
  const origConfig = client.config.split('\n---AMNEZIA_JSON---\n')[0];

  let vpnUri: string | null = null;
  if (protocol?.type === 'awg2' || protocol?.type === 'wireguard') {
    try {
      const amneziaJson = buildAmneziaExportJson(client, protocol, server);
      vpnUri = buildVpnUri(amneziaJson);
    } catch { /* ignore */ }
  }

  res.json({ config: origConfig, vpnUri, name: client.name });
});

router.delete('/:id', async (req, res) => {
  const existing = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!existing) return res.json({ ok: true }); // уже удалён
  const client = loadClient(req, res);
  if (!client) return;

  // Отзыв доступа на сервере. При ошибке НЕ удаляем запись — админ повторит,
  // когда сервер будет доступен (иначе «удалённый» клиент остался бы рабочим).
  // Приостановленный клиент уже снят с сервера, повторный отзыв безвреден.
  try {
    await revokePeer(loadClientContext(client));
  } catch (e) {
    logger.error({ err: e }, 'Failed to revoke client on server');
    return res.status(502).json({
      error: `Не удалось отозвать клиента на сервере: ${(e as Error).message}. Клиент НЕ удалён — повторите, когда сервер будет доступен.`,
    });
  }

  purgeClientRows(client.id);
  res.json({ ok: true });
});

router.get('/:id/subscription', (req, res) => {
  // slug — это фактически пароль от конфига: по нему подписка отдаётся без
  // авторизации. Поэтому проверка владельца здесь обязательна.
  if (!loadClient(req, res)) return;
  const subs = query<{ slug: string }>('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  res.json({ slug: subs[0]?.slug || null });
});

// ─── GET /api/clients/:id/stats ──────────────────────────────────────────────
//
// Возвращает per-client traffic статистику. range ∈ { 1h, 24h, 7d, 30d } —
// дефолт 24h. series downsampled до ~60 точек по бакетам времени; rate
// считается из cumulative bytes между соседними снимками (нет данных для
// пары = no point). При container restart cumulative обнуляется — отрицательный
// дельту мы клампим в 0.
const RANGE_SECONDS: Record<string, number> = {
  '1h':  60 * 60,
  '24h': 24 * 60 * 60,
  '7d':  7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};
const ONLINE_WINDOW_SEC = 180; // 3 минуты от last_handshake = online

interface StatsRow {
  ts: number;
  rx_bytes: number;
  tx_bytes: number;
  last_handshake: number | null;
}

router.get('/:id/stats', (req, res) => {
  const rangeKey = (typeof req.query.range === 'string' ? req.query.range : '24h');
  const rangeSec = RANGE_SECONDS[rangeKey] ?? RANGE_SECONDS['24h'];
  const now = Math.floor(Date.now() / 1000);
  const since = now - rangeSec;

  if (!loadClient(req, res)) return;

  const rows = query<StatsRow>(
    'SELECT ts, rx_bytes, tx_bytes, last_handshake FROM client_stats WHERE client_id = ? AND ts >= ? ORDER BY ts ASC',
    [req.params.id, since],
  );

  // Снимок непосредственно ПЕРЕД окном — база отсчёта, иначе терялся бы трафик
  // между ним и первым снимком внутри окна.
  const baseline = queryOne<StatsRow>(
    'SELECT ts, rx_bytes, tx_bytes, last_handshake FROM client_stats WHERE client_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1',
    [req.params.id, since],
  );

  const latest = rows.length ? rows[rows.length - 1] : null;
  const online = latest && latest.last_handshake
    ? (now - latest.last_handshake) < ONLINE_WINDOW_SEC
    : false;

  // Downsample: ~60 точек по бакетам, в каждом берём последний снимок.
  const BUCKETS = 60;
  const bucketSec = Math.max(60, Math.floor(rangeSec / BUCKETS));
  const series = rateSeries(downsample(rows, bucketSec));

  // Трафик ЗА ПЕРИОД — сумма приращений накопительных счётчиков. Раньше сюда
  // уходило значение последнего снимка, а оно одно и то же при любом окне,
  // поэтому переключение периода не меняло цифры.
  const total = sumTraffic(baseline ? [baseline, ...rows] : rows);

  res.json({
    online,
    lastHandshake: latest?.last_handshake ?? null,
    totalRx: total.rx,
    totalTx: total.tx,
    series,
  });
});

export default router;