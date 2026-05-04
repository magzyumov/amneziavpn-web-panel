import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { getDb, query, queryOne, run } from '../services/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { addAWG2Client, addXrayClient, addWireGuardClient } from '../services/protocols.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';

const router = Router();
router.use(authMiddleware);

router.get('/protocol/:protocolId', async (req, res) => {
  await getDb();
  const clients = query('SELECT id, name, created_at FROM clients WHERE protocol_id = ?', [req.params.protocolId]);
  res.json(clients);
});

router.post('/', async (req, res) => {
  await getDb();
  const { protocolId, name } = req.body;
  if (!protocolId || !name) return res.status(400).json({ error: 'protocolId and name required' });

  const protocol = queryOne('SELECT * FROM protocols WHERE id = ?', [protocolId]);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found' });
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [protocol.server_id]);

  const safeName = name.trim().replace(/[^a-zA-Z0-9_\-А-Яа-яёЁ ]/g, '').trim();
  if (!safeName) return res.status(400).json({ error: 'Invalid client name' });

  let result;
  if      (protocol.type === 'awg2')      result = await addAWG2Client(server, protocol, safeName);
  else if (protocol.type === 'xray')      result = await addXrayClient(server, protocol, safeName);
  else if (protocol.type === 'wireguard') result = await addWireGuardClient(server, protocol, safeName);
  else return res.status(400).json({ error: `Unsupported protocol: ${protocol.type}` });

  const id = uuidv4();
  const storedConfig = result.configJson
    ? `${result.config}\n---AMNEZIA_JSON---\n${result.configJson}`
    : result.config;

  run(
    'INSERT INTO clients (id, protocol_id, server_id, name, config) VALUES (?, ?, ?, ?, ?)',
    [id, protocolId, server.id, safeName, storedConfig]
  );

  // Для Xray автоматически создаём FLClash подписку
  let subscriptionSlug = null;
  if (protocol.type === 'xray') {
    try {
      const vpsHost = getVpsHost() || server.host;
      const { slug } = createSubscription({
        clientId: id,
        clientName: safeName,
        serverHost: vpsHost,
        vlessUrl: result.config,
      });
      subscriptionSlug = slug;
    } catch (e) {
      console.error('Failed to create subscription:', e.message);
    }
  }

  res.json({ id, name: safeName, config: result.config, type: result.type, subscriptionSlug });
});

// GET /api/clients/:id/config — скачать .conf файл (через JS fetch с авторизацией)
router.get('/:id/config', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = protocol?.type === 'xray' ? 'txt' : 'conf';
  // Отдаём только основной конфиг (vless URI или .conf), без JSON части
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/qr — QR код для клиента
// Для AmneziaVPN мобильного приложения: AWG2/WireGuard — Amnezia JSON формат
// Для Xray: VLESS URI формат (FLClash/v2rayNG)
router.get('/:id/qr', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);

  let configForQr;
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');

  if (protocol?.type === 'xray') {
    // Для Xray: VLESS URI — совместимо с FLClash/v2rayNG
    configForQr = parts[0];
  } else if (protocol?.type === 'awg2' || protocol?.type === 'wireguard') {
    // Для AWG2/WireGuard: AmneziaVPN мобильное приложение ожидает JSON формат из QR кода
    // Если есть JSON часть — используем её; иначе — .conf формат
    if (parts.length >= 2 && parts[1].trim()) {
      configForQr = parts[1].trim();
    } else {
      configForQr = parts[0];
    }
  } else {
    configForQr = parts[0];
  }

  const qr = await QRCode.toDataURL(configForQr, { width: 400, margin: 2, errorCorrectionLevel: 'L' });
  res.json({ qr });
});

router.get('/:id/config-text', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  // Возвращаем только vless URI или .conf (до разделителя)
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);

  // Также возвращаем Amnezia JSON если есть
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  const configJson = parts.length >= 2 ? parts[1] : null;

  res.json({ config, configJson, name: client.name, type: protocol?.type });
});

// GET /api/clients/:id/config-amnezia — JSON конфиг для AmneziaVPN (скачивание)
router.get('/:id/config-amnezia', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  if (parts.length < 2) return res.status(404).json({ error: 'No Amnezia JSON config' });
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}_amnezia.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(parts[1]);
});

router.delete('/:id', async (req, res) => {
  await getDb();
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  // Подписка удалится автоматически через CASCADE
  res.json({ ok: true });
});

// GET /api/clients/:id/subscription — получить slug подписки клиента
router.get('/:id/subscription', async (req, res) => {
  await getDb();
  const { query: dbQuery } = await import('../services/db.js');
  const subs = dbQuery('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  if (!subs.length) return res.json({ slug: null });
  res.json({ slug: subs[0].slug });
});

export default router;
