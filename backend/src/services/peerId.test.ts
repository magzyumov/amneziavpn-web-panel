import { describe, it, expect } from 'vitest';
import { extractPeerId } from './peerId.js';

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
