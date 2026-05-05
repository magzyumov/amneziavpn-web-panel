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

// Официальный формат Amnezia JSON — восстановлен по декодированным реальным vpn:// URI
function buildAmneziaExportJson(client, protocol, server) {
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  const conf = parts[0]; // оригинальный .conf текст

  const getConf = (key) => {
    const m = conf.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };

  let containerData = {};

  if (protocol.type === 'awg2') {
    const clientPrivKey = getConf('PrivateKey');
    const clientAddr    = getConf('Address');
    const clientIp      = clientAddr.split('/')[0];
    const serverPubKey  = getConf('PublicKey');
    const presharedKey  = getConf('PresharedKey');
    const endpoint      = getConf('Endpoint');
    const port          = endpoint.split(':').pop();
    const hostName      = server?.host || endpoint.split(':')[0] || '';
    const Jc = getConf('Jc'), Jmin = getConf('Jmin'), Jmax = getConf('Jmax');
    const S1 = getConf('S1'), S2 = getConf('S2'), S3 = getConf('S3'), S4 = getConf('S4');
    const H1 = getConf('H1'), H2 = getConf('H2'), H3 = getConf('H3'), H4 = getConf('H4');
    const I1 = getConf('I1'), I2 = getConf('I2'), I3 = getConf('I3');
    const I4 = getConf('I4'), I5 = getConf('I5');

    const lastConfigObj = {
      H1, H2, H3, H4, I1, I2, I3, I4, I5,
      Jc, Jmax, Jmin, S1, S2, S3, S4,
      allowed_ips: ['0.0.0.0/0', '::/0'],
      clientId: clientPrivKey,
      client_ip: clientIp,
      client_priv_key: clientPrivKey,
      client_pub_key: clientPrivKey,
      config: conf,
      hostName,
      mtu: '1376',
      persistent_keep_alive: '25',
      port: parseInt(port) || 0,
      psk_key: presharedKey,
      server_pub_key: serverPubKey,
    };

    containerData = {
      container: 'amnezia-awg2',
      awg: {
        H1, H2, H3, H4, I1, I2, I3, I4, I5,
        Jc, Jmax, Jmin, S1, S2, S3, S4,
        last_config: JSON.stringify(lastConfigObj, null, 4) + '\n',
        port: String(port),
        protocol_version: '2',
        subnet_address: '10.8.1.0',
        transport_proto: 'udp',
      },
    };

  } else if (protocol.type === 'wireguard') {
    const clientPrivKey = getConf('PrivateKey');
    const clientAddr    = getConf('Address');
    const clientIp      = clientAddr.split('/')[0];
    const serverPubKey  = getConf('PublicKey');
    const presharedKey  = getConf('PresharedKey');
    const endpoint      = getConf('Endpoint');
    const port          = endpoint.split(':').pop();
    const hostName      = server?.host || endpoint.split(':')[0] || '';

    const lastConfigObj = {
      allowed_ips: ['0.0.0.0/0', '::/0'],
      clientId: clientPrivKey,
      client_ip: clientIp,
      client_priv_key: clientPrivKey,
      client_pub_key: clientPrivKey,
      config: conf,
      hostName,
      mtu: '1420',
      persistent_keep_alive: '25',
      port: parseInt(port) || 0,
      psk_key: presharedKey,
      server_pub_key: serverPubKey,
    };

    containerData = {
      container: 'amnezia-wireguard',
      wireguard: {
        last_config: JSON.stringify(lastConfigObj, null, 4) + '\n',
        port: String(port),
        subnet_address: '10.8.1.0',
        transport_proto: 'udp',
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

  return JSON.stringify({
    containers: [containerData],
    defaultContainer: containerData.container,
    description: client.name,
    dns1: '1.1.1.1',
    dns2: '1.0.0.1',
    hostName: server?.host || '',
    nameOverriddenByUser: true,
  });
}

// Генерация vpn:// URI — официальный Amnezia формат
// Формат: "vpn://" + base64( uint32BE(uncompressedSize) + zlib_deflate(json_utf8) )
// Это Qt qCompress формат — первые 4 байта = размер несжатых данных (big-endian)
// Qt fromBase64 использует стандартный base64 (не url-safe, без замены +/-)
function buildVpnUriSync(amneziaJson) {
  const jsonBuf = Buffer.from(amneziaJson, 'utf8');
  // Qt qCompress: 4 байта big-endian = исходный размер, затем zlib deflate
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(jsonBuf.length, 0);
  const compressed = deflateSync(jsonBuf, { level: 9 });
  const result = Buffer.concat([sizeBuf, compressed]);
  // Стандартный base64 (Qt fromBase64 без флага Base64UrlEncoding)
  return `vpn://${result.toString('base64')}`;
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