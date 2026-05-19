/**
 * amneziaExport.ts
 *
 * Сборщик официального формата экспорта AmneziaVPN (JSON / vpn:// URI / chunked QR).
 * Восстановлен по декодированным реальным vpn:// URI и amnezia-client/client/core/utils/qrCodeUtils.cpp.
 *
 * Формат vpn://: qCompress(JSON) → base64url. qCompress = 4 байта BE длина + zlib(deflate).
 * Формат QR:     каждый chunk = QDataStream-обёртка вокруг куска qCompressed → base64url.
 */

import { deflateSync } from 'zlib';
import QRCode from 'qrcode';
import type { Client, Protocol, Server } from '../types.js';

// ─── Парсинг .conf формата (WireGuard-стиль key=value) ──────────────────────

interface ConfReader {
  /** Возвращает значение ключа из .conf или '' (не throw'ит даже на пустых строках). */
  get(key: string): string;
  /** Клиентский pub key, сохранённый при создании клиента в parts[1] (JSON). */
  savedPubKey(): string;
  /** Сырая полезная нагрузка xray (JSON из parts[1]). */
  xrayCfg(): unknown;
  /** Оригинальный .conf текст (parts[0]). */
  conf(): string;
}

function makeConfReader(rawConfig: string | null | undefined): ConfReader {
  const parts = (rawConfig ?? '').split('\n---AMNEZIA_JSON---\n');
  const conf = parts[0];

  return {
    conf: () => conf,
    // [ \t]* вместо \s* — не захватываем \n. .* — разрешаем пустые значения (I1-I5 могут быть пустыми).
    get(key) {
      const m = conf.match(new RegExp(`^${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    },
    savedPubKey() {
      if (!parts[1]) return '';
      try { return (JSON.parse(parts[1]) as { client_pub_key?: string }).client_pub_key || ''; }
      catch { return ''; }
    },
    xrayCfg() {
      if (!parts[1]) return {};
      try { return JSON.parse(parts[1]); } catch { return {}; }
    },
  };
}

// ─── Сборка Amnezia JSON-конфига (то, что вставляется в QR/vpn://) ──────────

interface ContainerData {
  container: string;
  awg?: Record<string, string>;
  wireguard?: Record<string, string>;
  xray?: { last_config: string };
}

function buildAwgContainer(reader: ConfReader, server: Server | null): ContainerData {
  const clientPrivKey  = reader.get('PrivateKey');
  const clientPubKey   = reader.savedPubKey();
  const serverPubKey   = reader.get('PublicKey');
  const presharedKey   = reader.get('PresharedKey');
  const clientIp       = reader.get('Address').split('/')[0];
  const endpoint       = reader.get('Endpoint');
  const port           = endpoint.split(':').pop() ?? '';
  const hostName       = server?.host || endpoint.split(':')[0] || '';
  const Jc = reader.get('Jc'), Jmin = reader.get('Jmin'), Jmax = reader.get('Jmax');
  const S1 = reader.get('S1'), S2 = reader.get('S2'), S3 = reader.get('S3'), S4 = reader.get('S4');
  const H1 = reader.get('H1'), H2 = reader.get('H2'), H3 = reader.get('H3'), H4 = reader.get('H4');
  const I1 = reader.get('I1'), I2 = reader.get('I2'), I3 = reader.get('I3');
  const I4 = reader.get('I4'), I5 = reader.get('I5');

  const lastConfigObj = {
    H1, H2, H3, H4, I1, I2, I3, I4, I5,
    Jc, Jmax, Jmin, S1, S2, S3, S4,
    allowed_ips: ['0.0.0.0/0', '::/0'],
    clientId: clientPubKey || clientPrivKey, // pub key; fallback на priv для старых клиентов
    client_ip: clientIp,
    client_priv_key: clientPrivKey,
    client_pub_key: clientPubKey,
    config: reader.conf(),
    hostName,
    mtu: '1376',
    persistent_keep_alive: '25',
    port: parseInt(port) || 0,
    psk_key: presharedKey,
    server_pub_key: serverPubKey,
  };

  return {
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
}

function buildWireGuardContainer(reader: ConfReader, server: Server | null): ContainerData {
  const clientPrivKey  = reader.get('PrivateKey');
  const clientPubKey   = reader.savedPubKey();
  const serverPubKey   = reader.get('PublicKey');
  const presharedKey   = reader.get('PresharedKey');
  const clientIp       = reader.get('Address').split('/')[0];
  const endpoint       = reader.get('Endpoint');
  const port           = endpoint.split(':').pop() ?? '';
  const hostName       = server?.host || endpoint.split(':')[0] || '';

  const lastConfigObj = {
    allowed_ips: ['0.0.0.0/0', '::/0'],
    clientId: clientPubKey || clientPrivKey,
    client_ip: clientIp,
    client_priv_key: clientPrivKey,
    client_pub_key: clientPubKey,
    config: reader.conf(),
    hostName,
    mtu: '1420',
    persistent_keep_alive: '25',
    port: parseInt(port) || 0,
    psk_key: presharedKey,
    server_pub_key: serverPubKey,
  };

  return {
    container: 'amnezia-wireguard',
    wireguard: {
      last_config: JSON.stringify(lastConfigObj, null, 4) + '\n',
      port: String(port),
      subnet_address: '10.8.1.0',
      transport_proto: 'udp',
    },
  };
}

function buildXrayContainer(reader: ConfReader): ContainerData {
  return {
    container: 'amnezia-xray',
    xray: { last_config: JSON.stringify(reader.xrayCfg()) },
  };
}

export function buildAmneziaExportJson(client: Client, protocol: Pick<Protocol, 'type'>, server: Server | null): string {
  const reader = makeConfReader(client.config);

  let containerData: ContainerData;
  if      (protocol.type === 'awg2')      containerData = buildAwgContainer(reader, server);
  else if (protocol.type === 'wireguard') containerData = buildWireGuardContainer(reader, server);
  else if (protocol.type === 'xray')      containerData = buildXrayContainer(reader);
  else throw new Error(`Unsupported protocol type for Amnezia export: ${protocol.type}`);

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

// ─── qCompress + vpn:// URI ──────────────────────────────────────────────────

// qCompress = 4 байта BE длина исходных данных + zlib(deflate, level=9).
// Используется и для vpn://, и как источник данных для chunked QR.
function buildQCompressedData(amneziaJson: string): Buffer {
  const jsonBuf = Buffer.from(amneziaJson, 'utf8');
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(jsonBuf.length, 0);
  const compressed = deflateSync(jsonBuf, { level: 9 });
  return Buffer.concat([sizeBuf, compressed]);
}

// AmneziaVPN декодирует через QByteArray::fromBase64(..., Base64UrlEncoding).
export function buildVpnUri(amneziaJson: string): string {
  return `vpn://${buildQCompressedData(amneziaJson).toString('base64url')}`;
}

// ─── Chunked QR ──────────────────────────────────────────────────────────────

// Протокол: сжатые данные режутся на куски по CHUNK_SIZE байт.
// Каждый кусок оборачивается в бинарный QDataStream-заголовок (big-endian):
//   qint16  magic       = 0x07C0 (1984)
//   quint8  totalChunks
//   quint8  chunkIndex  (0-based)
//   uint32  dataLength  (QByteArray length prefix)
//   bytes   data
// Результат base64url-кодируется и становится содержимым QR-кода.
// Источник: amnezia-client/client/core/utils/qrCodeUtils.cpp
const QR_MAGIC = 0x07C0;
const QR_CHUNK_SIZE = 850;

export async function buildChunkedAmneziaQr(amneziaJson: string): Promise<string[]> {
  const compressed = buildQCompressedData(amneziaJson);
  const chunks: Buffer[] = [];
  for (let i = 0; i < compressed.length; i += QR_CHUNK_SIZE) {
    chunks.push(compressed.subarray(i, i + QR_CHUNK_SIZE));
  }

  const qrImages: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const data = chunks[i];
    const buf = Buffer.alloc(2 + 1 + 1 + 4 + data.length);
    let off = 0;
    buf.writeInt16BE(QR_MAGIC, off);     off += 2;
    buf.writeUInt8(chunks.length, off);  off += 1;
    buf.writeUInt8(i, off);              off += 1;
    buf.writeUInt32BE(data.length, off); off += 4;
    data.copy(buf, off);

    const b64 = buf.toString('base64url');
    const img = await QRCode.toDataURL(b64, { width: 600, margin: 2, errorCorrectionLevel: 'L' });
    qrImages.push(img);
  }
  return qrImages;
}
