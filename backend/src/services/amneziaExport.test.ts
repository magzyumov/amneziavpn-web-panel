import { describe, it, expect } from 'vitest';
import { buildAmneziaExportJson, buildVpnUri } from './amneziaExport.js';
import type { Client, Server } from '../types.js';

const SEP = '\n---AMNEZIA_JSON---\n';
const I1 = '<r 2><b 0xdeadbeef>';
const HPK = '2PgMtXNQAWt9ul11vICYNYiLKBM8aO0cjMHWvWbbHng=';

function awgClient(extra = ''): Client {
  const conf = [
    '[Interface]',
    'Address = 10.8.1.2/32',
    'DNS = 172.29.172.254',
    'PrivateKey = CLIENTPRIV',
    'Jc = 5', 'Jmin = 10', 'Jmax = 50',
    'S1 = 77', 'S2 = 90', 'S3 = 33', 'S4 = 15',
    'H1 = 5-1000000', 'H2 = 1000001-2000000', 'H3 = 2000001-3000000', 'H4 = 3000001-4000000',
    `I1 = ${I1}`,
    extra,
    '',
    '[Peer]',
    'PublicKey = SERVERPUB',
    'PresharedKey = PSK',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = 203.0.113.7:51820',
    'PersistentKeepalive = 25',
  ].filter(l => l !== '').join('\n');
  return { name: 'TEST', config: `${conf}${SEP}{"client_pub_key":"CLIENTPUB"}` } as Client;
}

const server = { host: '203.0.113.7' } as Server;
const awgOf = (client: Client) =>
  JSON.parse(buildAmneziaExportJson(client, { type: 'awg2' }, server)).containers[0].awg;

describe('buildAmneziaExportJson — AWG', () => {
  it('переносит параметры обфускации в контейнер и last_config', () => {
    const awg = awgOf(awgClient());
    expect(awg.Jc).toBe('5');
    expect(awg.H1).toBe('5-1000000');
    expect(awg.I1).toBe(I1);
    expect(JSON.parse(awg.last_config).I1).toBe(I1);
  });

  it('AWG 3.0: HeaderProtectionKey доезжает и поднимает protocol_version до 3', () => {
    // Без этого приложение импортирует конфиг без header protection, и handshake
    // с сервером, который её требует, не проходит.
    const awg = awgOf(awgClient(`HeaderProtectionKey = ${HPK}`));
    expect(awg.HeaderProtectionKey).toBe(HPK);
    expect(JSON.parse(awg.last_config).HeaderProtectionKey).toBe(HPK);
    expect(awg.protocol_version).toBe('3');
  });

  it('без AWG3-параметров ключи не появляются вовсе, версия остаётся 2', () => {
    // Апстрим не пишет пустые значения: приложение вывело бы их в .conf строкой
    // "X = ", а на ней awg setconf падает.
    const awg = awgOf(awgClient());
    expect(awg).not.toHaveProperty('HeaderProtectionKey');
    expect(awg).not.toHaveProperty('ContentPaddingAddition');
    expect(awg.protocol_version).toBe('2');
  });

  it('client_pub_key берётся из сохранённой JSON-части', () => {
    const last = JSON.parse(awgOf(awgClient()).last_config);
    expect(last.client_pub_key).toBe('CLIENTPUB');
    expect(last.clientId).toBe('CLIENTPUB');
    expect(last.server_pub_key).toBe('SERVERPUB');
    expect(last.psk_key).toBe('PSK');
  });

  it('контейнер называется amnezia-awg2 — это идентификатор из DockerContainer', () => {
    const out = JSON.parse(buildAmneziaExportJson(awgClient(), { type: 'awg2' }, server));
    expect(out.containers[0].container).toBe('amnezia-awg2');
    expect(out.defaultContainer).toBe('amnezia-awg2');
  });
});

describe('buildVpnUri', () => {
  it('формирует vpn://<base64url> с префиксом длины', () => {
    const json = buildAmneziaExportJson(awgClient(), { type: 'awg2' }, server);
    const uri = buildVpnUri(json);
    expect(uri.startsWith('vpn://')).toBe(true);
    // qCompress: 4 байта BE длины исходных данных + zlib.
    const buf = Buffer.from(uri.slice('vpn://'.length), 'base64url');
    expect(buf.readUInt32BE(0)).toBe(Buffer.byteLength(json, 'utf8'));
  });
});

describe('buildAmneziaExportJson — прочее', () => {
  it('неподдерживаемый тип протокола бросает', () => {
    expect(() => buildAmneziaExportJson(awgClient(), { type: 'telemt' }, server)).toThrow();
  });
});
