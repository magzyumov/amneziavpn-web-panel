import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { deflateSync } from 'zlib';
import { getDb, query, queryOne, run } from '../services/db.js';
import { authMiddleware, JWT_SECRET } from '../middleware/auth.js';
import { addAWG2Client, addXrayClient, addWireGuardClient } from '../services/protocols.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';

const router = Router();

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function verifyQueryToken(req, res) {
  const token = req.query.token
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return null;
  }
}

// Официальный формат Amnezia JSON для импорта в AmneziaVPN
// { containers: [...], defaultContainer, description, dns1, dns2, hostName, port, ... }
function buildAmneziaExportJson(client, protocol, server) {
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  const conf = parts[0]; // оригинальный .conf текст

  const get = (key) => {
    const m = conf.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };

  let containerData = {};

  if (protocol.type === 'awg2') {
    containerData = {
      container: 'amnezia-awg',
      awg: {
        last_config: conf,
        Jc:   get('Jc'),
        Jmin: get('Jmin'),
        Jmax: get('Jmax'),
        S1:   get('S1'),
        S2:   get('S2'),
        S3:   get('S3'),
        S4:   get('S4'),
        H1:   get('H1'),
        H2:   get('H2'),
        H3:   get('H3'),
        H4:   get('H4'),
      },
    };
  } else if (protocol.type === 'wireguard') {
    containerData = {
      container: 'amnezia-wireguard',
      wireguard: {
        last_config: conf,
      },
    };
  } else if (protocol.type === 'xray') {
    let xrayCfg = {};
    if (parts[1]) { try { xrayCfg = JSON.parse(parts[1]); } catch {} }
    containerData = {
      container: 'amnezia-xray',
      xray: { last_config: JSON.stringify(xrayCfg) },
    };
  }

  const exportObj = {
    containers:       [containerData],
    defaultContainer: containerData.container,
    description:      client.name,
    dns1:             '1.1.1.1',
    dns2:             '8.8.8.8',
    hostName:         server?.host || '',
    port:             protocol?.port || 0,
    splitTunnelSites: [],
    splitTunnelType:  0,
  };

  return JSON.stringify(exportObj);
}

// Генерация vpn:// URI — официальный Amnezia deep-link формат
// vpn://AAA + base64url(zlib_deflate(json_utf8))
function buildVpnUriSync(amneziaJson) {
  const jsonBuf    = Buffer.from(amneziaJson, 'utf8');
  const compressed = deflateSync(jsonBuf, { level: 9 });
  const b64url     = compressed.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `vpn://AAA${b64url}`;
}

// ─── Публичные endpoints (token via query param) ──────────────────────────────

// GET /api/clients/:id/config — скачать оригинальный .conf
router.get('/:id/config', async (req, res) => {
  if (!verifyQueryToken(req, res)) return;
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = protocol?.type === 'xray' ? 'txt' : 'conf';
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/config-amnezia — скачать Amnezia JSON (.json файл)
router.get('/:id/config-amnezia', async (req, res) => {
  if (!verifyQueryToken(req, res)) return;
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);
  const amneziaJson = buildAmneziaExportJson(client, protocol, server);
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}_amnezia.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(amneziaJson);
});

// ─── Защищённые endpoints ─────────────────────────────────────────────────────
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
  run('INSERT INTO clients (id, protocol_id, server_id, name, config) VALUES (?, ?, ?, ?, ?)',
    [id, protocolId, server.id, safeName, storedConfig]);

  let subscriptionSlug = null;
  if (protocol.type === 'xray') {
    try {
      const vpsHost = getVpsHost() || server.host;
      const { slug } = createSubscription({ clientId: id, clientName: safeName, serverHost: vpsHost, vlessUrl: result.config });
      subscriptionSlug = slug;
    } catch (e) { console.error('Failed to create subscription:', e.message); }
  }

  res.json({ id, name: safeName, config: result.config, type: result.type, subscriptionSlug });
});

// GET /api/clients/:id/qr — QR для оригинального формата (.conf / VLESS URI)
router.get('/:id/qr', async (req, res) => {
  await getDb();
  const client   = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);

  // Оригинальный QR — .conf для WG/AWG, VLESS URI для Xray
  const origConfig = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  const origQr = await QRCode.toDataURL(origConfig, { width: 400, margin: 2, errorCorrectionLevel: 'L' });

  // Amnezia QR — vpn:// URI (только для WG и AWG)
  let amneziaQr = null;
  let vpnUri = null;
  if (protocol?.type === 'awg2' || protocol?.type === 'wireguard') {
    try {
      const amneziaJson = buildAmneziaExportJson(client, protocol, server);
      vpnUri = buildVpnUriSync(amneziaJson);
      amneziaQr = await QRCode.toDataURL(vpnUri, { width: 400, margin: 2, errorCorrectionLevel: 'L' });
    } catch (e) {
      console.error('vpn:// QR error:', e.message);
    }
  }

  res.json({ qr: origQr, amneziaQr, vpnUri });
});

// GET /api/clients/:id/config-text — текст оригинального конфига
router.get('/:id/config-text', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);
  const origConfig = client.config.split('\n---AMNEZIA_JSON---\n')[0];

  // Для AWG/WG также отдаём vpn:// URI
  let vpnUri = null;
  if (protocol?.type === 'awg2' || protocol?.type === 'wireguard') {
    try {
      const amneziaJson = buildAmneziaExportJson(client, protocol, server);
      vpnUri = buildVpnUriSync(amneziaJson);
    } catch {}
  }

  res.json({ config: origConfig, vpnUri, name: client.name });
});

router.delete('/:id', async (req, res) => {
  await getDb();
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.get('/:id/subscription', async (req, res) => {
  await getDb();
  const subs = query('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  res.json({ slug: subs[0]?.slug || null });
});

export default router;


const router = Router();

// ─── Маршруты, доступные по токену в query-параметре (для window.open / QR) ────
// Должны быть ДО router.use(authMiddleware) !

function verifyQueryToken(req, res) {
  const token = req.query.token
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Invalid token' }); return null;
  }
}

// Сборка Amnezia-совместимого JSON для импорта в приложение AmneziaVPN
// Официальный формат: https://github.com/amnezia-vpn/amnezia-client
function buildAmneziaExportJson(client, protocol, server) {
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  const conf = parts[0]; // .conf текст

  let containerData = {};

  if (protocol.type === 'awg2' || protocol.type === 'wireguard') {
    // Парсим .conf файл
    const get = (key) => {
      const m = conf.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mi'));
      return m ? m[1].trim() : '';
    };

    if (protocol.type === 'awg2') {
      containerData = {
        container: 'amnezia-awg',
        awg: {
          last_config: conf,
          Jc: get('Jc'), Jmin: get('Jmin'), Jmax: get('Jmax'),
          S1: get('S1'), S2: get('S2'), S3: get('S3'), S4: get('S4'),
          H1: get('H1'), H2: get('H2'), H3: get('H3'), H4: get('H4'),
        },
      };
    } else {
      containerData = {
        container: 'amnezia-wireguard',
        wireguard: {
          last_config: conf,
        },
      };
    }
  } else if (protocol.type === 'xray') {
    // Для Xray — берём клиентский JSON конфиг
    let xrayCfg = {};
    if (parts[1]) {
      try { xrayCfg = JSON.parse(parts[1]); } catch {}
    }
    containerData = {
      container: 'amnezia-xray',
      xray: {
        last_config: JSON.stringify(xrayCfg),
      },
    };
  }

  // Официальная обёртка Amnezia
  const exportObj = {
    containers: [containerData],
    defaultContainer: containerData.container,
    description: client.name,
    dns1: '1.1.1.1',
    dns2: '8.8.8.8',
    hostName: server?.host || '',
    port: protocol.port || 0,
    splitTunnelSites: [],
    splitTunnelType: 0,
  };

  return JSON.stringify(exportObj);
}

// GET /api/clients/:id/config — скачать .conf (WireGuard / AWG)
router.get('/:id/config', async (req, res) => {
  if (!verifyQueryToken(req, res)) return;
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = protocol?.type === 'xray' ? 'txt' : 'conf';
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/config-amnezia — скачать Amnezia JSON (правильный формат)
router.get('/:id/config-amnezia', async (req, res) => {
  if (!verifyQueryToken(req, res)) return;
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);

  const amneziaJson = buildAmneziaExportJson(client, protocol, server);
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}_amnezia.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(amneziaJson);
});

// ─── Остальные маршруты требуют Bearer токена ────────────────────────────────
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

router.get('/:id/qr', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);

  let configForQr;
  if (protocol?.type === 'xray') {
    // Для Xray: VLESS URI — совместимо с FLClash/v2rayNG
    configForQr = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  } else {
    // Для AWG2/WireGuard: используем правильный Amnezia JSON формат с containers[]
    configForQr = buildAmneziaExportJson(client, protocol, server);
  }

  const qr = await QRCode.toDataURL(configForQr, { width: 400, margin: 2, errorCorrectionLevel: 'L' });
  res.json({ qr });
});

router.get('/:id/config-text', async (req, res) => {
  await getDb();
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.json({ config, name: client.name });
});

router.delete('/:id', async (req, res) => {
  await getDb();
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/clients/:id/subscription
router.get('/:id/subscription', async (req, res) => {
  await getDb();
  const subs = query('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  if (!subs.length) return res.json({ slug: null });
  res.json({ slug: subs[0].slug });
});

export default router;
