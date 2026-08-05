import { describe, it, expect } from 'vitest';
import { CONFIGURE_SCRIPTS } from './dockerfiles.js';
import { normalizeXraySettings, settingsFromConfig, buildVlessUrl, renderXrayClient } from './xray.js';

// Рендерит server.json из heredoc'а configure-скрипта Xray с подставленными
// переменными — так же, как это делает bash внутри контейнера.
function renderServerJson(vars: Record<string, string>): any {
  const script = CONFIGURE_SCRIPTS.xray;
  const start = script.indexOf('<<EOF');
  expect(start).toBeGreaterThan(-1);
  const body = script.slice(script.indexOf('\n', start) + 1, script.lastIndexOf('EOF'));
  const rendered = body.replace(/\$[A-Z0-9_]+/g, (m) => vars[m.slice(1)] ?? '');
  return JSON.parse(rendered);
}

const REALITY_BLOCK = ',\n "realitySettings": { "dest": "www.googletagmanager.com:443", "serverNames": ["www.googletagmanager.com"], "privateKey": "priv", "shortIds": ["f9612bdf0dc35a8c"] }';

const TCP_VARS = {
  XRAY_SERVER_PORT: '443',
  XRAY_CLIENT_ID: '0df05d85-48d4-4967-b2cb-fb43b51ab8e4',
  XRAY_SITE_NAME: 'www.googletagmanager.com',
  XRAY_NETWORK: 'tcp',
  XRAY_SECURITY: 'reality',
  XRAY_REALITY_BLOCK: REALITY_BLOCK,
  XRAY_FLOW_SUFFIX: ', "flow": "xtls-rprx-vision"',
  XRAY_XHTTP_BLOCK: '',
};

describe('xray server.json template', () => {
  it('рендерится в валидный JSON', () => {
    const json = renderServerJson(TCP_VARS);
    expect(json.inbounds).toHaveLength(2);
  });

  // Клиент AmneziaVPN (4.8.x и 5.0.x) правит именно inbounds[0]: ставит туда
  // порт/streamSettings и дописывает клиента. Если первым окажется служебный
  // api-inbound, приложение перенастроит его на порт протокола и трафик встанет.
  it('держит vless первым inbound, api — последним', () => {
    const json = renderServerJson(TCP_VARS);
    expect(json.inbounds[0].protocol).toBe('vless');
    expect(json.inbounds[0].port).toBe(443);
    expect(json.inbounds.at(-1).tag).toBe('api');
    expect(json.inbounds.at(-1).protocol).toBe('dokodemo-door');
  });

  // Тег "api" принадлежит API-хендлеру Xray (api.tag), его нельзя занимать
  // собственным outbound'ом — иначе routing-правило stats бьётся с blackhole.
  it('не занимает тег api собственным outbound', () => {
    const json = renderServerJson(TCP_VARS);
    expect(json.api.tag).toBe('api');
    expect(json.outbounds.map((o: any) => o.tag)).toEqual(['direct', 'block']);
    expect(json.routing.rules[0].outboundTag).toBe('api');
  });

  it('при security=none не пишет realitySettings', () => {
    const json = renderServerJson({ ...TCP_VARS, XRAY_SECURITY: 'none', XRAY_REALITY_BLOCK: '', XRAY_FLOW_SUFFIX: '' });
    const stream = json.inbounds[0].streamSettings;
    expect(stream.security).toBe('none');
    expect(stream.realitySettings).toBeUndefined();
    expect(json.inbounds[0].settings.clients[0].flow).toBeUndefined();
  });

  it('кладёт xhttp-блок внутрь streamSettings и не ставит flow', () => {
    const json = renderServerJson({
      ...TCP_VARS,
      XRAY_NETWORK: 'xhttp',
      XRAY_FLOW_SUFFIX: '',
      XRAY_XHTTP_BLOCK: ',\n "xhttpSettings": { "host": "h.example.com", "path": "/", "mode": "auto" }',
    });
    const stream = json.inbounds[0].streamSettings;
    expect(stream.network).toBe('xhttp');
    expect(stream.xhttpSettings).toEqual({ host: 'h.example.com', path: '/', mode: 'auto' });
    expect(json.inbounds[0].settings.clients[0].flow).toBeUndefined();
  });
});

describe('normalizeXraySettings', () => {
  it('по умолчанию даёт прежнее поведение: reality + vision + chrome + tcp', () => {
    expect(normalizeXraySettings()).toEqual({
      sni: 'www.googletagmanager.com', security: 'reality', fingerprint: 'chrome',
      flow: 'xtls-rprx-vision', transport: 'tcp', xhttpHost: '', xhttpPath: '', xhttpMode: '',
    });
  });

  // Vision шифровать нечего без TLS — Xray отвергнет такой конфиг.
  it('снимает flow при security=none', () => {
    const s = normalizeXraySettings({ security: 'none', flow: 'xtls-rprx-vision' });
    expect(s.security).toBe('none');
    expect(s.flow).toBe('');
    expect(s.fingerprint).toBe('');
  });

  it('снимает flow при транспорте xhttp', () => {
    const s = normalizeXraySettings({ transport: 'xhttp', flow: 'xtls-rprx-vision' });
    expect(s.flow).toBe('');
    expect(s.xhttpMode).toBe('auto');
    expect(s.xhttpPath).toBe('/');
    expect(s.xhttpHost).toBe('www.googletagmanager.com');
  });

  it('чистит xhttp-поля при возврате на tcp', () => {
    const base = normalizeXraySettings({ transport: 'xhttp', xhttpHost: 'h.example.com', xhttpPath: '/x' });
    const s = normalizeXraySettings({ transport: 'tcp' }, base);
    expect(s).toMatchObject({ transport: 'tcp', xhttpHost: '', xhttpPath: '', xhttpMode: '' });
  });

  it('наследует неуказанные поля из базовых настроек', () => {
    const base = normalizeXraySettings({ sni: 'swdist.apple.com', fingerprint: 'firefox' });
    const s = normalizeXraySettings({ security: 'none' }, base);
    expect(s.sni).toBe('swdist.apple.com');
  });

  it('отвергает мусор в значениях', () => {
    expect(() => normalizeXraySettings({ security: 'tls' })).toThrow();
    expect(() => normalizeXraySettings({ fingerprint: 'netscape' })).toThrow();
    expect(() => normalizeXraySettings({ flow: 'xtls-rprx-direct' })).toThrow();
    expect(() => normalizeXraySettings({ sni: 'evil.com; rm -rf /' })).toThrow();
  });
});

describe('settingsFromConfig', () => {
  // Конфиги, созданные до появления выбора, полей security/flow не имеют.
  it('трактует старый конфиг как reality + vision', () => {
    const s = settingsFromConfig({ port: 443, sni: 'www.googletagmanager.com' });
    expect(s.security).toBe('reality');
    expect(s.flow).toBe('xtls-rprx-vision');
    expect(s.fingerprint).toBe('chrome');
  });

  it('читает новый конфиг как есть', () => {
    const s = settingsFromConfig({ port: 443, sni: 'swdist.apple.com', security: 'none', flow: '', transport: 'tcp' });
    expect(s).toMatchObject({ security: 'none', flow: '', sni: 'swdist.apple.com' });
  });
});

// Клиентский конфиг едет внутрь vpn://-ссылки, и приложение ничего не сообщит,
// если он невалиден — просто не поднимет xray. Проверяем, что JSON парсится
// во всех режимах: на этом уже ловились битые подстановки в шаблоне.
describe('renderXrayClient', () => {
  const server = { host: '10.0.0.1' } as any;
  const baseConfig = { port: 443, publicKey: 'PUB', shortId: 'SID', firstUuid: 'u0' };

  const parse = (cfg: Record<string, unknown>) => {
    const r = renderXrayClient(server, { ...baseConfig, ...cfg }, 'uuid-1', 'Client');
    return JSON.parse(r.configJson!);
  };

  it('reality: валидный JSON с realitySettings и flow', () => {
    const json = parse({ sni: 'swdist.apple.com', security: 'reality', fingerprint: 'firefox', flow: 'xtls-rprx-vision' });
    const stream = json.outbounds[0].streamSettings;
    expect(stream.security).toBe('reality');
    expect(stream.realitySettings).toMatchObject({ fingerprint: 'firefox', serverName: 'swdist.apple.com', publicKey: 'PUB', shortId: 'SID' });
    expect(json.outbounds[0].settings.vnext[0].users[0].flow).toBe('xtls-rprx-vision');
  });

  it('none: валидный JSON без realitySettings и без flow', () => {
    const json = parse({ security: 'none', flow: '' });
    const stream = json.outbounds[0].streamSettings;
    expect(stream.security).toBe('none');
    expect(stream.realitySettings).toBeUndefined();
    expect(json.outbounds[0].settings.vnext[0].users[0].flow).toBeUndefined();
  });

  it('xhttp: валидный JSON с xhttpSettings', () => {
    const json = parse({ security: 'reality', transport: 'xhttp', xhttpHost: 'h.example.com', xhttpPath: '/x', xhttpMode: 'auto' });
    const stream = json.outbounds[0].streamSettings;
    expect(stream.network).toBe('xhttp');
    expect(stream.xhttpSettings).toEqual({ host: 'h.example.com', path: '/x', mode: 'auto' });
  });

  it('socks-inbound на месте — по нему приложение находит локальный порт', () => {
    const json = parse({ security: 'none' });
    expect(json.inbounds[0].protocol).toBe('socks');
    expect(json.inbounds[0].port).toBe(10808);
  });
});

describe('buildVlessUrl', () => {
  const base = normalizeXraySettings();

  it('для reality несёт pbk/fp/sni/sid и flow', () => {
    const url = buildVlessUrl(base, '10.0.0.1', 443, 'uuid-1', 'Client', 'PUB', 'SID');
    expect(url).toContain('security=reality');
    expect(url).toContain('pbk=PUB');
    expect(url).toContain('sid=SID');
    expect(url).toContain('fp=chrome');
    expect(url).toContain('flow=xtls-rprx-vision');
  });

  // Без TLS параметров Reality быть не должно: клиент полезет в TLS-рукопожатие
  // там, где сервер его не ждёт.
  it('для none не несёт параметров reality', () => {
    const s = normalizeXraySettings({ security: 'none' });
    const url = buildVlessUrl(s, '10.0.0.1', 443, 'uuid-1', 'Client', 'PUB', 'SID');
    expect(url).toContain('security=none');
    expect(url).not.toContain('pbk=');
    expect(url).not.toContain('sid=');
    expect(url).not.toContain('fp=');
    expect(url).not.toContain('flow=');
  });

  it('для xhttp несёт host/path/mode', () => {
    const s = normalizeXraySettings({ transport: 'xhttp', xhttpPath: '/api/v1' });
    const url = buildVlessUrl(s, '10.0.0.1', 443, 'uuid-1', 'Client', 'PUB', 'SID');
    expect(url).toContain('type=xhttp');
    expect(url).toContain('path=%2Fapi%2Fv1');
    expect(url).toContain('mode=auto');
  });
});
