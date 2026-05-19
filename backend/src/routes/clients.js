import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { deflateSync } from 'zlib';
import { query, queryOne, run } from '../services/db.js';
import { authMiddleware, verifyAuth } from '../middleware/auth.js';
import { addAWG2Client, addXrayClient, addWireGuardClient } from '../services/protocols.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';

const router = Router();

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function requireAuth(req, res) {
  const user = verifyAuth(req);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return user;
}

// Официальный формат Amnezia JSON — восстановлен по декодированным реальным vpn:// URI
function buildAmneziaExportJson(client, protocol, server) {
  const parts = client.config.split('\n---AMNEZIA_JSON---\n');
  const conf = parts[0]; // оригинальный .conf текст

  // [ \t]* вместо \s* — не захватываем \n, иначе пустые строки поглощают следующую
  // .* вместо .+ — разрешаем пустые значения (I1-I5 могут быть пустыми)
  const getConf = (key) => {
    const m = conf.match(new RegExp(`^${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  // Клиентский публичный ключ хранится в parts[1] (сохраняется при создании клиента).
  // Для старых клиентов (без parts[1]) вместо clientPubKey остаётся пустая строка.
  const getSavedPubKey = () => {
    if (!parts[1]) return '';
    try { return JSON.parse(parts[1]).client_pub_key || ''; } catch { return ''; }
  };

  let containerData = {};

  if (protocol.type === 'awg2') {
    const clientPrivKey  = getConf('PrivateKey');
    const clientPubKey   = getSavedPubKey();   // сохранённый при создании клиента
    const serverPubKey   = getConf('PublicKey');  // [Peer].PublicKey — серверный ключ
    const presharedKey   = getConf('PresharedKey');
    const clientAddr     = getConf('Address');
    const clientIp       = clientAddr.split('/')[0];
    const endpoint       = getConf('Endpoint');
    const port           = endpoint.split(':').pop();
    const hostName       = server?.host || endpoint.split(':')[0] || '';
    const Jc = getConf('Jc'), Jmin = getConf('Jmin'), Jmax = getConf('Jmax');
    const S1 = getConf('S1'), S2 = getConf('S2'), S3 = getConf('S3'), S4 = getConf('S4');
    const H1 = getConf('H1'), H2 = getConf('H2'), H3 = getConf('H3'), H4 = getConf('H4');
    const I1 = getConf('I1'), I2 = getConf('I2'), I3 = getConf('I3');
    const I4 = getConf('I4'), I5 = getConf('I5');

    const lastConfigObj = {
      H1, H2, H3, H4, I1, I2, I3, I4, I5,
      Jc, Jmax, Jmin, S1, S2, S3, S4,
      allowed_ips: ['0.0.0.0/0', '::/0'],
      clientId: clientPubKey || clientPrivKey,  // pub key; fallback на priv для старых клиентов
      client_ip: clientIp,
      client_priv_key: clientPrivKey,
      client_pub_key: clientPubKey,
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
    const clientPrivKey  = getConf('PrivateKey');
    const clientPubKey   = getSavedPubKey();
    const serverPubKey   = getConf('PublicKey');
    const presharedKey   = getConf('PresharedKey');
    const clientAddr     = getConf('Address');
    const clientIp       = clientAddr.split('/')[0];
    const endpoint       = getConf('Endpoint');
    const port           = endpoint.split(':').pop();
    const hostName       = server?.host || endpoint.split(':')[0] || '';

    const lastConfigObj = {
      allowed_ips: ['0.0.0.0/0', '::/0'],
      clientId: clientPubKey || clientPrivKey,
      client_ip: clientIp,
      client_priv_key: clientPrivKey,
      client_pub_key: clientPubKey,
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

// Строит сжатый блок в формате qCompress (4 байта big-endian размер + zlib data).
// Используется и для vpn:// URI (текст), и как источник данных для chunked QR.
function buildQCompressedData(amneziaJson) {
  const jsonBuf = Buffer.from(amneziaJson, 'utf8');
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(jsonBuf.length, 0);
  const compressed = deflateSync(jsonBuf, { level: 9 });
  return Buffer.concat([sizeBuf, compressed]);
}

// Генерация vpn:// URI для текстового/clipboard импорта.
// AmneziaVPN декодирует через QByteArray::fromBase64(..., Base64UrlEncoding).
function buildVpnUriSync(amneziaJson) {
  return `vpn://${buildQCompressedData(amneziaJson).toString('base64url')}`;
}

// Генерация chunked QR-кодов — официальный QR-формат AmneziaVPN.
//
// Протокол: сжатые данные режутся на куски по CHUNK_SIZE байт.
// Каждый кусок оборачивается в бинарный QDataStream-заголовок (big-endian):
//   qint16  magic       = 0x07C0 (1984)
//   quint8  totalChunks
//   quint8  chunkIndex  (0-based)
//   uint32  dataLength  (QByteArray length prefix)
//   bytes   data
// Результат base64url-кодируется и становится содержимым QR-кода.
// Источник: amnezia-client/client/core/utils/qrCodeUtils.cpp
const QR_MAGIC  = 0x07C0;   // 1984
const CHUNK_SIZE = 850;

async function buildChunkedAmneziaQr(amneziaJson) {
  const compressed = buildQCompressedData(amneziaJson);
  const chunks = [];
  for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
    chunks.push(compressed.slice(i, i + CHUNK_SIZE));
  }

  const qrImages = [];
  for (let i = 0; i < chunks.length; i++) {
    const data = chunks[i];
    // QDataStream big-endian: qint16 + quint8 + quint8 + uint32 + bytes
    const buf = Buffer.alloc(2 + 1 + 1 + 4 + data.length);
    let off = 0;
    buf.writeInt16BE(QR_MAGIC, off);   off += 2;
    buf.writeUInt8(chunks.length, off); off += 1;
    buf.writeUInt8(i, off);             off += 1;
    buf.writeUInt32BE(data.length, off); off += 4;
    data.copy(buf, off);

    const b64 = buf.toString('base64url');
    const img = await QRCode.toDataURL(b64, { width: 600, margin: 2, errorCorrectionLevel: 'L' });
    qrImages.push(img);
  }
  return qrImages;
}

// ─── Endpoints скачивания конфигов (auth через httpOnly cookie) ──────────────

// GET /api/clients/:id/config — скачать оригинальный .conf
router.get('/:id/config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = protocol?.type === 'xray' ? 'txt' : 'conf';
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/config-amnezia — скачать Amnezia JSON (.json файл)
router.get('/:id/config-amnezia', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
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
  const clients = query(
    'SELECT id, name, created_at, (config IS NOT NULL) as has_config FROM clients WHERE protocol_id = ?',
    [req.params.protocolId]
  );
  res.json(clients);
});

router.post('/', async (req, res) => {
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

  const created = queryOne('SELECT created_at FROM clients WHERE id = ?', [id]);
  res.json({ id, name: safeName, config: result.config, type: result.type, subscriptionSlug, has_config: 1, created_at: created?.created_at });
});

// GET /api/clients/:id/qr — QR для оригинального формата (.conf / VLESS URI)
router.get('/:id/qr', async (req, res) => {
  const client   = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.json({ qr: null, amneziaQr: null, vpnUri: null, noConfig: true });
  const protocol = queryOne('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne('SELECT * FROM servers WHERE id = ?', [client.server_id]);

  // Оригинальный QR — .conf для WG/AWG, VLESS URI для Xray
  const origConfig = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  const origQr = await QRCode.toDataURL(origConfig, { width: 400, margin: 2, errorCorrectionLevel: 'L' });

  // Amnezia QR — chunked binary format для сканирования камерой (все протоколы).
  // vpnUri — текстовый vpn:// URI для clipboard-импорта.
  let amneziaQrParts = null;
  let vpnUri = null;
  if (protocol?.type === 'awg2' || protocol?.type === 'wireguard' || protocol?.type === 'xray') {
    try {
      const amneziaJson = buildAmneziaExportJson(client, protocol, server);
      vpnUri = buildVpnUriSync(amneziaJson);
      amneziaQrParts = await buildChunkedAmneziaQr(amneziaJson);
    } catch (e) {
      console.error('Amnezia QR error:', e.message);
    }
  }

  // amneziaQr оставляем для обратной совместимости (первая часть)
  const amneziaQr = amneziaQrParts?.[0] ?? null;
  res.json({ qr: origQr, amneziaQr, amneziaQrParts, vpnUri });
});

// GET /api/clients/:id/config-text — текст оригинального конфига
router.get('/:id/config-text', async (req, res) => {
  const client = queryOne('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.json({ config: null, vpnUri: null, name: client.name, noConfig: true });
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
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.get('/:id/subscription', async (req, res) => {
  const subs = query('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  res.json({ slug: subs[0]?.slug || null });
});

export default router;