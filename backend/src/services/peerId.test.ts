import { describe, it, expect } from 'vitest';
import { extractPeerId, extractPeerRestoreInfo } from './peerId.js';

const SEP = '\n---AMNEZIA_JSON---\n';

describe('extractPeerId — AWG/WireGuard', () => {
  const conf = `[Interface]\nPrivateKey = X\n${SEP}{"client_pub_key":"PUBKEY123="}`;

  it('берёт client_pub_key из JSON-части', () => {
    expect(extractPeerId(conf, 'awg2')).toBe('PUBKEY123=');
    expect(extractPeerId(conf, 'wireguard')).toBe('PUBKEY123=');
  });

  it('без JSON-части возвращает null, а не падает', () => {
    expect(extractPeerId('[Interface]\nPrivateKey = X', 'awg2')).toBeNull();
  });

  it('битый JSON возвращает null, а не бросает', () => {
    expect(extractPeerId(`conf${SEP}{не json`, 'awg2')).toBeNull();
  });
});

describe('extractPeerId — Xray', () => {
  it('берёт UUID из vless-ссылки', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(extractPeerId(`vless://${uuid}@1.2.3.4:443?type=tcp`, 'xray')).toBe(uuid);
  });

  it('не-vless строка даёт null', () => {
    expect(extractPeerId('https://example.com', 'xray')).toBeNull();
  });
});

describe('extractPeerId — Telemt', () => {
  // peer_id обязан совпадать с username в [access.users] (c_<12 hex секрета>),
  // иначе статистика из API прокси не смапится на клиента.
  const secret = '0123456789abcdef0123456789abcdef';

  it('ee-ссылка (FakeTLS): срезает префикс и домен', () => {
    const domainHex = Buffer.from('www.google.com', 'utf8').toString('hex');
    const link = `https://t.me/proxy?server=h&port=443&secret=ee${secret}${domainHex}`;
    expect(extractPeerId(link, 'telemt')).toBe('c_0123456789ab');
  });

  it('dd-ссылка (secure mode, легаси) разбирается тем же кодом', () => {
    expect(extractPeerId(`https://t.me/proxy?server=h&port=443&secret=dd${secret}`, 'telemt'))
      .toBe('c_0123456789ab');
  });

  it('ссылка без secret даёт null', () => {
    expect(extractPeerId('https://t.me/proxy?server=h&port=443', 'telemt')).toBeNull();
  });
});

describe('extractPeerId — границы', () => {
  it('пустой конфиг и неизвестный тип дают null', () => {
    expect(extractPeerId(null, 'awg2')).toBeNull();
    expect(extractPeerId('', 'awg2')).toBeNull();
    expect(extractPeerId('что угодно', 'неизвестный')).toBeNull();
  });
});

// Возврат пира после приостановки по суточному лимиту обязан идти ТЕМ ЖЕ
// ключом и адресом — иначе выданный клиенту конфиг переставал бы работать
// каждые сутки. Всё нужное берётся из уже сохранённого конфига.
describe('extractPeerRestoreInfo', () => {
  const wgConf = [
    '[Interface]',
    'Address = 10.8.1.7/32',
    'DNS = 172.29.172.254',
    'PrivateKey = privkey==',
    '',
    '[Peer]',
    'PublicKey = serverpub=',
    'PresharedKey = psk123==',
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');

  it('AWG/WG: берёт адрес без маски и preshared-key', () => {
    expect(extractPeerRestoreInfo(`${wgConf}${SEP}{"client_pub_key":"P="}`, 'awg2'))
      .toEqual({ clientIp: '10.8.1.7', presharedKey: 'psk123==' });
    expect(extractPeerRestoreInfo(wgConf, 'wireguard'))
      .toEqual({ clientIp: '10.8.1.7', presharedKey: 'psk123==' });
  });

  it('AWG/WG: без PresharedKey восстановить нельзя — null, а не половина данных', () => {
    expect(extractPeerRestoreInfo('[Interface]\nAddress = 10.8.1.7/32', 'awg2')).toBeNull();
  });

  it('Telemt: достаёт сырой secret из-под ee-префикса', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const link = `https://t.me/proxy?server=h&port=443&secret=ee${secret}77777`;
    expect(extractPeerRestoreInfo(link, 'telemt')).toEqual({ secret });
  });

  it('Telemt: обрезанный secret не годится для восстановления', () => {
    expect(extractPeerRestoreInfo('https://t.me/proxy?secret=eeabc', 'telemt')).toBeNull();
  });

  it('Xray: восстанавливается по одному uuid, дополнительных данных не нужно', () => {
    expect(extractPeerRestoreInfo('vless://uuid@h:443', 'xray')).toEqual({});
  });

  it('пустой конфиг даёт null', () => {
    expect(extractPeerRestoreInfo(null, 'awg2')).toBeNull();
  });
});
