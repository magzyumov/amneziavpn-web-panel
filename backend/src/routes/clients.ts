import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { authMiddleware, verifyAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { addAWG2Client, addXrayClient, addWireGuardClient } from '../services/protocols/index.js';
import { createSubscription, getVpsHost } from '../services/subscription.js';
import { buildAmneziaExportJson, buildVpnUri, buildChunkedAmneziaQr } from '../services/amneziaExport.js';
import { logger } from '../services/logger.js';
import type { Server, Protocol, Client, ProtocolType } from '../types.js';

const router = Router();

// ─── Утилиты ─────────────────────────────────────────────────────────────────

const createClientSchema = z.object({
  protocolId: z.string().min(1),
  name: z.string().min(1).max(128),
});

function requireAuth(req: Request, res: Response): { id: string; username: string } | null {
  const user = verifyAuth(req);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return user;
}

// ─── Endpoints скачивания конфигов (auth через httpOnly cookie) ──────────────

// GET /api/clients/:id/config — скачать оригинальный .conf
router.get('/:id/config', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const client = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const ext = protocol?.type === 'xray' ? 'txt' : 'conf';
  const config = client.config.split('\n---AMNEZIA_JSON---\n')[0];
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.${ext}"`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(config);
});

// GET /api/clients/:id/config-amnezia — скачать Amnezia JSON (.json файл)
router.get('/:id/config-amnezia', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const client = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.config) return res.status(409).json({ error: 'Config unavailable: client was imported from an existing server and the original private key is not stored' });
  const protocol = queryOne<{ type: ProtocolType }>('SELECT type FROM protocols WHERE id = ?', [client.protocol_id]);
  const server   = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [client.server_id]);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found' });
  const amneziaJson = buildAmneziaExportJson(client, protocol, server);
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}_amnezia.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(amneziaJson);
});

// ─── Защищённые endpoints ─────────────────────────────────────────────────────
router.use(authMiddleware);

router.get('/protocol/:protocolId', (req, res) => {
  const clients = query(
    'SELECT id, name, created_at, (config IS NOT NULL) as has_config FROM clients WHERE protocol_id = ?',
    [req.params.protocolId]
  );
  res.json(clients);
});

router.post('/', validateBody(createClientSchema), async (req: Request, res: Response) => {
  const { protocolId, name } = req.body as { protocolId: string; name: string };
  const protocol = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [protocolId]);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found' });
  const server = queryOne<Server>('SELECT * FROM servers WHERE id = ?', [protocol.server_id]);
  if (!server) return res.status(404).json({ error: 'Server not found' });
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

  let subscriptionSlug: string | null = null;
  if (protocol.type === 'xray') {
    try {
      const vpsHost = getVpsHost() || server.host;
      const { slug } = createSubscription({ clientId: id, clientName: safeName, serverHost: vpsHost, vlessUrl: result.config });
      subscriptionSlug = slug;
    } catch (e) { logger.error({ err: e }, 'Failed to create subscription'); }
  }

  const created = queryOne<{ created_at: string }>('SELECT created_at FROM clients WHERE id = ?', [id]);
  res.json({ id, name: safeName, config: result.config, type: result.type, subscriptionSlug, has_config: 1, created_at: created?.created_at });
});

// GET /api/clients/:id/qr — QR для оригинального формата (.conf / VLESS URI)
router.get('/:id/qr', async (req, res) => {
  const client   = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
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
  const client = queryOne<Client>('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Not found' });
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

router.delete('/:id', (req, res) => {
  run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.get('/:id/subscription', (req, res) => {
  const subs = query<{ slug: string }>('SELECT slug FROM subscriptions WHERE client_id = ?', [req.params.id]);
  res.json({ slug: subs[0]?.slug || null });
});

export default router;