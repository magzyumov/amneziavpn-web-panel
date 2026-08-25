import { describe, it, expect } from 'vitest';
import { AWG2_CLIENT_TEMPLATE, AWG2_CLIENT_JSON_TEMPLATE } from './dockerfiles.js';
import { renderTemplate } from './common.js';

// Клиентский конфиг AWG собирается двумя многострочными плейсхолдерами
// ($AWG3_CLIENT_PARAMS и $AWG3_JSON_FIELDS), которые addAWG2Client склеивает
// вручную из строк. Ошибка в склейке даёт либо конфиг, где AWG3-параметры
// уехали в [Peer] (awg setconf их проигнорирует), либо невалидный JSON внутри
// vpn://-ссылки — и то и другое проявляется только на живом клиенте.

const BASE = {
  WIREGUARD_CLIENT_IP: '10.8.1.2',
  CLIENT_DNS: '172.29.172.254, 1.1.1.1',
  WIREGUARD_CLIENT_PRIVATE_KEY: 'cHJpdmF0ZUtleUJhc2U2NFN0cmluZ0Zvclc1VGVzdGluZzE9',
  WIREGUARD_CLIENT_PUBLIC_KEY: 'cHVibGljS2V5QmFzZTY0U3RyaW5nRm9yV0dUZXN0aW5nMTE9',
  JUNK_PACKET_COUNT: 5, JUNK_PACKET_MIN_SIZE: 10, JUNK_PACKET_MAX_SIZE: 50,
  INIT_PACKET_JUNK_SIZE: 30, RESPONSE_PACKET_JUNK_SIZE: 40,
  COOKIE_REPLY_PACKET_JUNK_SIZE: 20, TRANSPORT_PACKET_JUNK_SIZE: 15,
  INIT_PACKET_MAGIC_HEADER: '5-100', RESPONSE_PACKET_MAGIC_HEADER: '100-200',
  UNDERLOAD_PACKET_MAGIC_HEADER: '200-300', TRANSPORT_PACKET_MAGIC_HEADER: '300-400',
  SPECIAL_JUNK_1: '<r 2><b 0x8580>', SPECIAL_JUNK_2: '', SPECIAL_JUNK_3: '',
  SPECIAL_JUNK_4: '', SPECIAL_JUNK_5: '',
  PROTOCOL_VERSION: '3.1',
  WIREGUARD_SERVER_PUBLIC_KEY: 'c2VydmVyUHVibGljS2V5QmFzZTY0Rm9yVGVzdGluZ1gxMD0=',
  WIREGUARD_PSK: 'cHJlc2hhcmVkS2V5QmFzZTY0U3RyaW5nRm9yVGVzdGluZzE9',
  SERVER_IP_ADDRESS: '203.0.113.10',
  AWG_SERVER_PORT: 29063,
  PERSISTENT_KEEPALIVE: '25-35',
};

// Так их собирает addAWG2Client: строки конфига через \n + завершающий перевод,
// поля JSON через ',\n' с ведущей запятой.
const AWG3_CONF_LINES = [
  'HeaderProtectionKey = aGVhZGVyUHJvdGVjdGlvbktleUJhc2U2NFN0cmluZzE9',
  'ContentPaddingAddition = 10-100',
  'RandomTrailers = on',
  'DisableCookies = on',
];
const AWG3_JSON_LINES = [
  '        "headerProtectionKey": "aGVhZGVyUHJvdGVjdGlvbktleUJhc2U2NFN0cmluZzE9"',
  '        "randomTrailers": "on"',
  '        "disableCookies": "on"',
];

const withAwg3 = {
  ...BASE,
  AWG3_CLIENT_PARAMS: `${AWG3_CONF_LINES.join('\n')}\n`,
  AWG3_JSON_FIELDS: `,\n${AWG3_JSON_LINES.join(',\n')}`,
};
const withoutAwg3 = { ...BASE, AWG3_CLIENT_PARAMS: '', AWG3_JSON_FIELDS: '', PERSISTENT_KEEPALIVE: '25' };

describe('AWG2_CLIENT_TEMPLATE', () => {
  it('кладёт AWG 3.x параметры в [Interface], а не в [Peer]', () => {
    const conf = renderTemplate(AWG2_CLIENT_TEMPLATE, withAwg3);
    const iface = conf.slice(conf.indexOf('[Interface]'), conf.indexOf('[Peer]'));
    for (const line of AWG3_CONF_LINES) {
      expect(iface).toContain(line);
    }
  });

  it('без AWG 3.x параметров не оставляет висячих строк "key ="', () => {
    const conf = renderTemplate(AWG2_CLIENT_TEMPLATE, withoutAwg3);
    expect(conf).not.toMatch(/^\s*\w+\s*=\s*$/m);
    expect(conf).not.toContain('RandomTrailers');
  });

  it('PersistentKeepalive подставляется — диапазон для 3.1, одиночное для старых', () => {
    expect(renderTemplate(AWG2_CLIENT_TEMPLATE, withAwg3)).toContain('PersistentKeepalive = 25-35');
    expect(renderTemplate(AWG2_CLIENT_TEMPLATE, withoutAwg3)).toContain('PersistentKeepalive = 25');
    expect(renderTemplate(AWG2_CLIENT_TEMPLATE, withAwg3)).not.toContain('$PERSISTENT_KEEPALIVE');
  });

  it('не оставляет неподставленных плейсхолдеров', () => {
    for (const vars of [withAwg3, withoutAwg3]) {
      expect(renderTemplate(AWG2_CLIENT_TEMPLATE, vars)).not.toMatch(/\$[A-Z0-9_]+/);
    }
  });
});

describe('AWG2_CLIENT_JSON_TEMPLATE', () => {
  it('остаётся валидным JSON и с AWG 3.x полями, и без них', () => {
    const withParams = JSON.parse(renderTemplate(AWG2_CLIENT_JSON_TEMPLATE, withAwg3));
    expect(withParams.config.randomTrailers).toBe('on');
    expect(withParams.config.disableCookies).toBe('on');
    expect(withParams.protocol_version).toBe('3.1');

    const plain = JSON.parse(renderTemplate(AWG2_CLIENT_JSON_TEMPLATE, withoutAwg3));
    expect(plain.config.randomTrailers).toBeUndefined();
    expect(plain.config.i5).toBe('');
  });
});
