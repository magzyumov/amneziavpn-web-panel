import { execSudo } from '../ssh.js';
import {
  assertContainerName, assertPort, shInt, assertMagicHeader, assertUint32Range, assertWgKey,
  assertOnOff,
} from '../shell.js';
import { randInt, randPort, renderTemplate } from './common.js';
import {
  DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS,
  AWG2_CLIENT_TEMPLATE, AWG2_CLIENT_JSON_TEMPLATE,
} from './dockerfiles.js';
import { resolveClientDns } from './dns.js';
import {
  installWgLike, assertContainerRunning, genPeerKeys, nextClientIp, addPeer, removePeer,
  type WgFlavor,
} from './wgCommon.js';
import { UserError } from '../errors.js';
import type {
  Server, Protocol, AddClientResult, InstallResult, Awg2Config,
} from '../../types.js';

interface InstallOptions {
  port?: number;
  jc?: number; jmin?: number; jmax?: number;
  s1?: number; s2?: number; s3?: number; s4?: number;
  // H1-H4 в AWG 2.0 — диапазоны "min-max" либо одиночные uint32.
  h1?: number | string; h2?: number | string; h3?: number | string; h4?: number | string;
  // AWG 3.0/3.1. Тумблеры выключаются только явным false (по умолчанию — вкл,
  // как в AmneziaVPN 5.0.1.5). Остальные — тип "uint32,range".
  headerProtection?: boolean;
  randomTrailers?: boolean;
  disableCookies?: boolean;
  contentPaddingAddition?: string;
  rekeyAfterTime?: string;
  rekeyTimeout?: string;
  rejectAfterTime?: string;
  keepaliveTimeout?: string;
  maxHandshakeAttempts?: string;
  persistentKeepalive?: string;
}

// Базовые размеры handshake-пакетов AmneziaWG (AwgConstant). Нужны, чтобы итоговые
// размеры (base + S) не совпадали между собой — иначе amneziawg-go отвергнет конфиг.
const MSG_INIT = 148, MSG_RESP = 92, MSG_COOKIE = 64, MSG_TRANSPORT = 32;
const INT32_MAX = 2147483647;

// Дефолтный special junk пакет I1 из AmneziaVPN (protocolConstants.h:194) —
// мимикрирует под DNS-ответ для icloud.com. I2-I5 в апстриме пустые.
// Образ amneziawg-go I-пакеты ПОДДЕРЖИВАЕТ (проверено 2026-07-31): I1 активен в
// клиентском конфиге (AWG2_CLIENT_TEMPLATE). I2-I5 остаются пустыми/закомментированными,
// т.к. awg setconf падает на пустой строке "I2 =". Серверный awg0.conf I не задаёт
// (обфускация инициатора). Значения храним один-в-один с апстримом.
const DEFAULT_I1 = '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>';

// Дефолтные magic headers AmneziaVPN — используются как fallback для старых
// конфигов, где H1-H4 ещё не сохранены (protocolConstants.h:191-194).
const DEFAULT_H = { h1: '1020325451', h2: '3288052141', h3: '1766607858', h4: '2528465083' };

// Дефолты таймингов AWG 3.x — один-в-один с AmneziaVPN 5.0.1.5
// (protocolConstants.h, namespace awg). До 5.0.1.5 апстрим их не задавал вовсе,
// поэтому у инсталляций панели старше этого релиза они пустые.
const AWG3_DEFAULTS = {
  contentPaddingAddition: '10-100',
  rekeyAfterTime: '100-120',
  rekeyTimeout: '3-7',
  rejectAfterTime: '150-180',
  keepaliveTimeout: '5-15',
  maxHandshakeAttempts: '15-20',
} as const;

// PersistentKeepalive: AWG 3.1 делает его диапазоном (рандомизация тайминга),
// на инсталляциях без AWG3-параметров остаётся классическая одиночная 25.
const AWG3_PERSISTENT_KEEPALIVE = '25-35';
const DEFAULT_PERSISTENT_KEEPALIVE = '25';

// Форма шлёт boolean'ы, но через `options: z.record(z.unknown())` может прилететь
// и строка. Тумблер считается выключенным только при явном false/"false" —
// отсутствие значения означает «дефолт», а дефолт у всех трёх тумблеров — вкл.
function toggleOn(v: unknown): boolean {
  return !(v === false || v === 'false');
}

// Минимальный размер S1-S4 при включённой header protection: S-паддинг служит
// nonce для шифра заголовков, и amneziawg-go 3.x жёстко требует >= 12 (проверено:
// с S3=5 и заданным HeaderProtectionKey `awg setconf` падает с "Unable to modify
// interface: Invalid argument"). Апстримные нижние границы (s3 от 0, s4 от 0) с
// header protection несовместимы.
const HP_MIN_JUNK = 12;

// S4 в AmneziaVPN 5.0.1.5 не рандомизируется — protocolConstants::defaultTransportPacketJunkSize.
const UPSTREAM_S4 = 12;

// Генерация S1-S4 — копия AwgInstaller::generateAwgParameters из AmneziaVPN 5.0.1.5:
// значения уникальны и не дают совпадающих итоговых размеров пакетов. Границы
// апстримные (junkPacketSizeMin=12, S1/S2 < 150, S3 < 64), S4 прибит к 12
// (defaultTransportPacketJunkSize). min поднимается до HP_MIN_JUNK при header protection.
export function genPacketSizes(min: number): { s1: number; s2: number; s3: number; s4: number } {
  const lo = Math.max(HP_MIN_JUNK, min);
  const s4 = UPSTREAM_S4;
  const s1 = randInt(lo, 149);
  const used = new Set<number>([s1, s4]);
  let s2 = randInt(lo, 149);
  while (used.has(s2) || s1 + MSG_INIT === s2 + MSG_RESP) s2 = randInt(lo, 149);
  used.add(s2);
  let s3 = randInt(lo, 63);
  while (used.has(s3) || s1 + MSG_INIT === s3 + MSG_COOKIE || s2 + MSG_RESP === s3 + MSG_COOKIE) s3 = randInt(lo, 63);
  return { s1, s2, s3, s4 };
}

// H1-H4 при header protection — апстримные ОДИНОЧНЫЕ 1/2/3/4, а не случайные диапазоны.
//
// Это не косметика. В AWG 3.1 приёмник с RandomTrailers сначала проверяет ЛЮБОЙ
// пакет размером больше S1+148 на попадание в диапазон H1, затем H2, затем H3
// (device/receive.go: DeterminePacketTypeAndPadding) — размер больше не отсеивает
// транспортные пакеты, как это было в 3.0. Байты, по которым считается заголовок,
// в транспортном пакете — шифртекст, то есть равномерный шум, поэтому доля ложных
// срабатываний равна ширине диапазона / 2^32. Со случайными диапазонами шириной
// в сотни миллионов это ~28% транспортных пакетов, опознанных как битый handshake
// и выброшенных, — в каждую сторону (проверено на живом сервере 25.08.2026).
// Одиночное значение даёт ложное срабатывание раз на 4 млрд, а сами заголовки
// всё равно скрыты header protection, так что энтропию мы не теряем.
const UPSTREAM_H: [string, string, string, string] = ['1', '2', '3', '4'];

// Диапазоны остаются только для AWG 2.0 (header protection выключена): там
// RandomTrailers нет, приёмник отсеивает транспорт по точному размеру, и широкий
// диапазон безопасен. Диапазоны возрастающие и непересекающиеся → заголовки различны.
function genMagicHeaderRanges(): [string, string, string, string] {
  const out: string[] = [];
  let min = 5;
  while (out.length < 4) {
    const first = randInt(min, INT32_MAX - 1);
    const second = randInt(first, INT32_MAX - 1);
    min = second;
    out.push(`${first}-${second}`);
  }
  return out as [string, string, string, string];
}

// Тег образа включает версию amneziawg-go — чтобы по `docker images` было видно,
// что реально крутится, и чтобы предыдущая версия осталась на диске для отката.
// Пересборку триггерит не тег, а изменение Dockerfile (buildImage сравнивает
// метку panel.dockerfile-sha), так что бамп базового образа виден и без смены тега.
// containerName 'amnezia-awg2' — идентификатор апстрима (DockerContainer::Awg2),
// а не «AmneziaWG версии 2». У апстрима два слота под AmneziaWG: 'amnezia-awg'
// читает конфиг из wg0.conf, 'amnezia-awg2' — из awg0.conf. Мы пишем awg0.conf,
// значит слот именно второй; переименование сломало бы и импорт vpn://-конфига
// приложением, и подхват серверов, развёрнутых настоящим клиентом AmneziaVPN.
export const AWG2_FLAVOR: WgFlavor = {
  tool: 'awg',
  iface: 'awg0',
  confDir: '/opt/amnezia/awg',
  containerName: 'amnezia-awg2',
  imageName: 'amnezia-awg2:3.1.20260814',
  buildDir: '/opt/amnezia/amnezia-awg2',
  label: 'AmneziaWG',
};

const SUBNET_PREFIX = '10.8.1';

export async function installAWG2(server: Server, options: InstallOptions = {}): Promise<InstallResult> {
  const port      = assertPort(options.port || randPort());
  const subnetIp  = `${SUBNET_PREFIX}.0`;
  const subnetCidr = '24';
  // Параметры обфускации AWG 2.0 — дефолты и алгоритм один-в-один с апстримом
  // (AwgInstaller::generateAwgParameters). Все значения валидируем перед
  // интерполяцией в configure-script.
  // Пустая строка = «поле в форме очищено» = дефолт, а не 0: форма шлёт '' для
  // не заполненных числовых полей.
  const intOpt = (v: number | undefined, fallback: number, label: string): number =>
    v == null || (v as unknown) === '' ? fallback : shInt(v, { min: 0, max: 4294967295, label });
  const jc   = intOpt(options.jc,   randInt(4, 6), 'jc');   // upstream bounded(4,7)
  const jmin = intOpt(options.jmin, 10,            'jmin');
  const jmax = intOpt(options.jmax, 50,            'jmax');

  // AWG 3.0/3.1: все три тумблера включены по умолчанию, выключаются явным false.
  const headerProtection = toggleOn(options.headerProtection);
  const randomTrailers = toggleOn(options.randomTrailers);
  const disableCookies = toggleOn(options.disableCookies);

  // S1-S4 генерируем единым набором (уникальны + без коллизий размеров пакетов),
  // одиночные override'ы валидируем поверх. При header protection все четыре
  // обязаны быть >= HP_MIN_JUNK — иначе awg setconf отвергнет конфиг.
  const sMin = headerProtection ? HP_MIN_JUNK : 0;
  const gen = genPacketSizes(sMin);
  const s1 = intOpt(options.s1, gen.s1, 's1');
  const s2 = intOpt(options.s2, gen.s2, 's2');
  const s3 = intOpt(options.s3, gen.s3, 's3');
  const s4 = intOpt(options.s4, gen.s4, 's4');
  if (headerProtection) {
    for (const [label, v] of [['s1', s1], ['s2', s2], ['s3', s3], ['s4', s4]] as const) {
      if (v < HP_MIN_JUNK) {
        throw new UserError(`Invalid ${label}: header protection requires S1-S4 >= ${HP_MIN_JUNK}, got ${v}`);
      }
    }
  }

  // Тайминги AWG 3.x — тип "uint32,range". Дефолты берём апстримные; очищенное
  // поле формы ('' ) означает «не задавать параметр вовсе», а не «взять дефолт».
  const rangeOpt = (v: string | undefined, fallback: string, label: string): string =>
    v == null ? fallback : v === '' ? '' : assertUint32Range(v, label);
  const contentPaddingAddition = rangeOpt(options.contentPaddingAddition, AWG3_DEFAULTS.contentPaddingAddition, 'contentPaddingAddition');
  const rekeyAfterTime         = rangeOpt(options.rekeyAfterTime,         AWG3_DEFAULTS.rekeyAfterTime,         'rekeyAfterTime');
  const rekeyTimeout           = rangeOpt(options.rekeyTimeout,           AWG3_DEFAULTS.rekeyTimeout,           'rekeyTimeout');
  const rejectAfterTime        = rangeOpt(options.rejectAfterTime,        AWG3_DEFAULTS.rejectAfterTime,        'rejectAfterTime');
  const keepaliveTimeout       = rangeOpt(options.keepaliveTimeout,       AWG3_DEFAULTS.keepaliveTimeout,       'keepaliveTimeout');
  const maxHandshakeAttempts   = rangeOpt(options.maxHandshakeAttempts,   AWG3_DEFAULTS.maxHandshakeAttempts,   'maxHandshakeAttempts');
  const persistentKeepalive    = rangeOpt(options.persistentKeepalive,    AWG3_PERSISTENT_KEEPALIVE,            'persistentKeepalive')
    || DEFAULT_PERSISTENT_KEEPALIVE;

  // H1-H4: при header protection — апстримные 1/2/3/4 (см. UPSTREAM_H), иначе
  // диапазоны AWG 2.0.
  const gh = headerProtection ? UPSTREAM_H : genMagicHeaderRanges();
  const h1 = options.h1 != null ? assertMagicHeader(options.h1, 'h1') : gh[0];
  const h2 = options.h2 != null ? assertMagicHeader(options.h2, 'h2') : gh[1];
  const h3 = options.h3 != null ? assertMagicHeader(options.h3, 'h3') : gh[2];
  const h4 = options.h4 != null ? assertMagicHeader(options.h4, 'h4') : gh[3];

  // HeaderProtectionKey (AWG 3.0) генерируем тем же `awg genkey`, что и остальные
  // ключи — внутри уже запущенного контейнера, поэтому configure-скрипт собирается
  // отложенно (installWgLike вызовет это после docker run).
  let headerProtectionKey = '';
  const buildConfigureScript = async (): Promise<string> => {
    if (headerProtection) {
      const hpkRes = await execSudo(server, `docker exec ${AWG2_FLAVOR.containerName} awg genkey`);
      if (hpkRes.code !== 0 || !hpkRes.stdout.trim()) {
        throw new UserError(`Failed to generate AWG3 header protection key: ${hpkRes.stderr || 'empty output'}`);
      }
      headerProtectionKey = assertWgKey(hpkRes.stdout.trim(), 'headerProtectionKey');
    }
    // Пустое значение параметра = ошибка парсинга у awg setconf, поэтому строку
    // либо пишем целиком, либо не пишем вовсе (вместо неё — комментарий).
    // Тайминги и тумблеры уезжают и в серверный конфиг тоже — так же, как в
    // configure_container.sh AmneziaVPN 5.0.1.5.
    const serverLines: string[] = [];
    if (headerProtectionKey) serverLines.push(`HeaderProtectionKey = ${headerProtectionKey}`);
    for (const [key, value] of [
      ['ContentPaddingAddition', contentPaddingAddition],
      ['RekeyAfterTime',         rekeyAfterTime],
      ['RekeyTimeout',           rekeyTimeout],
      ['RejectAfterTime',        rejectAfterTime],
      ['KeepaliveTimeout',       keepaliveTimeout],
      ['MaxHandshakeAttempts',   maxHandshakeAttempts],
    ] as const) {
      if (value) serverLines.push(`${key} = ${value}`);
    }
    serverLines.push(`RandomTrailers = ${randomTrailers ? 'on' : 'off'}`);
    serverLines.push(`DisableCookies = ${disableCookies ? 'on' : 'off'}`);
    const awg3ServerParams = serverLines.length
      ? serverLines.join('\n')
      : '# AWG 3.x parameters disabled';

    return [
      `export AWG3_SERVER_PARAMS='${awg3ServerParams}'`,
      `export AWG_SUBNET_IP=${subnetIp}`,
      `export WIREGUARD_SUBNET_CIDR=${subnetCidr}`,
      `export AWG_SERVER_PORT=${port}`,
      `export JUNK_PACKET_COUNT=${jc}`,
      `export JUNK_PACKET_MIN_SIZE=${jmin}`,
      `export JUNK_PACKET_MAX_SIZE=${jmax}`,
      `export INIT_PACKET_JUNK_SIZE=${s1}`,
      `export RESPONSE_PACKET_JUNK_SIZE=${s2}`,
      `export COOKIE_REPLY_PACKET_JUNK_SIZE=${s3}`,
      `export TRANSPORT_PACKET_JUNK_SIZE=${s4}`,
      `export INIT_PACKET_MAGIC_HEADER=${h1}`,
      `export RESPONSE_PACKET_MAGIC_HEADER=${h2}`,
      `export UNDERLOAD_PACKET_MAGIC_HEADER=${h3}`,
      `export TRANSPORT_PACKET_MAGIC_HEADER=${h4}`,
      '',
      CONFIGURE_SCRIPTS.awg2,
    ].join('\n');
  };

  const serverPubKey = await installWgLike(server, AWG2_FLAVOR, {
    port, subnetIp, subnetCidr,
    dockerfile: DOCKERFILES.awg2,
    startScript: START_SCRIPTS.awg2(subnetIp, subnetCidr, server.host),
    configureScript: buildConfigureScript,
    configurePath: '/opt/amnezia/configure_awg.sh',
    serverPubKeyPath: `${AWG2_FLAVOR.confDir}/wireguard_server_public_key.key`,
  });

  const config: Awg2Config = {
    port, subnetIp, subnetCidr, serverPubKey,
    // protocolVersion=3.1 означает "инсталляция знает про AWG 3.x" — по нему
    // addAWG2Client решает, можно ли писать AWG3-параметры в клиентский конфиг.
    // Строка совпадает с awgV3 из AmneziaVPN 5.0.1.5, чтобы приложение показывало
    // правильную версию протокола. Старое значение '3' у уже установленных
    // протоколов остаётся валидным — его понимают и панель, и клиент.
    protocolVersion: headerProtection ? '3.1' : '2',
    jc, jmin, jmax,
    s1, s2, s3, s4,
    h1, h2, h3, h4,
    i1: DEFAULT_I1, i2: '', i3: '', i4: '', i5: '',
    headerProtectionKey,
    contentPaddingAddition, rekeyAfterTime, rekeyTimeout,
    rejectAfterTime, keepaliveTimeout, maxHandshakeAttempts,
    randomTrailers: randomTrailers ? 'on' : 'off',
    disableCookies: disableCookies ? 'on' : 'off',
    persistentKeepalive,
  };
  return { containerName: AWG2_FLAVOR.containerName, port, config };
}

export async function addAWG2Client(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new UserError('AmneziaWG protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  await assertContainerRunning(server, AWG2_FLAVOR);
  const { clientPrivKey, clientPubKey } = await genPeerKeys(server, AWG2_FLAVOR);

  // В отличие от WireGuard здесь PSK свой у каждого клиента, а не общий серверный.
  const pskRes = await execSudo(server, `docker exec ${AWG2_FLAVOR.containerName} awg genpsk`);
  const presharedKey = pskRes.stdout.trim();
  if (!presharedKey) {
    throw new UserError('Failed to generate AmneziaWG PSK: empty output');
  }

  const clientIp = await nextClientIp(server, AWG2_FLAVOR, SUBNET_PREFIX);
  await addPeer(server, AWG2_FLAVOR, { clientPubKey, presharedKey, clientIp });

  const clientDns = await resolveClientDns(server);

  // I1 активен в клиентском шаблоне и должен быть валидным DSL-пакетом (<r N>/<b 0x..>).
  // Legacy-инсталляции (до парити) хранят i1 как случайный uint32 — это не I-пакет,
  // а мусор; для них подставляем корректный DEFAULT_I1 (мимикрия под icloud DNS).
  const i1 = (typeof c.i1 === 'string' && c.i1.trimStart().startsWith('<')) ? c.i1 : DEFAULT_I1;

  // Параметры AWG 3.0 пишем только для инсталляций, где они реально заданы:
  // на старом сервере (amneziawg-go 0.2.x) HeaderProtectionKey в клиентском конфиге
  // сломает handshake, а пустое значение — сам парсинг конфига. Значения из БД
  // валидируем перед подстановкой.
  const awg3Lines: string[] = [];
  const awg3Json: string[] = [];
  const pushAwg3 = (confKey: string, jsonKey: string, raw: unknown, validate: (v: unknown, label: string) => string) => {
    if (typeof raw !== 'string' || raw === '') return;
    const value = validate(raw, jsonKey);
    awg3Lines.push(`${confKey} = ${value}`);
    awg3Json.push(`        "${jsonKey}": "${value}"`);
  };
  pushAwg3('HeaderProtectionKey',  'headerProtectionKey',  c.headerProtectionKey,  assertWgKey);
  pushAwg3('ContentPaddingAddition', 'contentPaddingAddition', c.contentPaddingAddition, assertUint32Range);
  pushAwg3('RekeyAfterTime',       'rekeyAfterTime',       c.rekeyAfterTime,       assertUint32Range);
  pushAwg3('RekeyTimeout',         'rekeyTimeout',         c.rekeyTimeout,         assertUint32Range);
  pushAwg3('RejectAfterTime',      'rejectAfterTime',      c.rejectAfterTime,      assertUint32Range);
  pushAwg3('KeepaliveTimeout',     'keepaliveTimeout',     c.keepaliveTimeout,     assertUint32Range);
  pushAwg3('MaxHandshakeAttempts', 'maxHandshakeAttempts', c.maxHandshakeAttempts, assertUint32Range);
  // AWG 3.1. 'off' пишем так же явно, как 'on': awg-tools трактует отсутствие
  // ключа и off одинаково, но в конфиге у клиента виден выбранный режим.
  pushAwg3('RandomTrailers',       'randomTrailers',       c.randomTrailers,       assertOnOff);
  pushAwg3('DisableCookies',       'disableCookies',       c.disableCookies,       assertOnOff);

  // Плейсхолдер занимает отдельную строку шаблона: пустое значение схлопывается в
  // пустую строку-разделитель перед [Peer], непустое — в блок строк + разделитель.
  const awg3ClientParams = awg3Lines.length ? `${awg3Lines.join('\n')}\n` : '';
  const awg3JsonFields = awg3Json.length ? `,\n${awg3Json.join(',\n')}` : '';

  const templateVars: Record<string, string | number> = {
    WIREGUARD_CLIENT_IP: clientIp,
    CLIENT_DNS: clientDns,
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
    WIREGUARD_CLIENT_PUBLIC_KEY: clientPubKey,
    JUNK_PACKET_COUNT: c.jc ?? randInt(4, 6),
    JUNK_PACKET_MIN_SIZE: c.jmin ?? 10,
    JUNK_PACKET_MAX_SIZE: c.jmax ?? 50,
    INIT_PACKET_JUNK_SIZE: c.s1 ?? 15,
    RESPONSE_PACKET_JUNK_SIZE: c.s2 ?? 18,
    COOKIE_REPLY_PACKET_JUNK_SIZE: c.s3 ?? 20,
    TRANSPORT_PACKET_JUNK_SIZE: c.s4 ?? 23,
    INIT_PACKET_MAGIC_HEADER: c.h1 ?? DEFAULT_H.h1,
    RESPONSE_PACKET_MAGIC_HEADER: c.h2 ?? DEFAULT_H.h2,
    UNDERLOAD_PACKET_MAGIC_HEADER: c.h3 ?? DEFAULT_H.h3,
    TRANSPORT_PACKET_MAGIC_HEADER: c.h4 ?? DEFAULT_H.h4,
    SPECIAL_JUNK_1: i1,
    SPECIAL_JUNK_2: c.i2 ?? '',
    SPECIAL_JUNK_3: c.i3 ?? '',
    SPECIAL_JUNK_4: c.i4 ?? '',
    SPECIAL_JUNK_5: c.i5 ?? '',
    AWG3_CLIENT_PARAMS: awg3ClientParams,
    AWG3_JSON_FIELDS: awg3JsonFields,
    // Инсталляции до AWG 3.1 диапазона не знают — им остаётся классическая 25.
    PERSISTENT_KEEPALIVE: typeof c.persistentKeepalive === 'string' && c.persistentKeepalive
      ? assertUint32Range(c.persistentKeepalive, 'persistentKeepalive')
      : '25',
    PROTOCOL_VERSION: typeof c.protocolVersion === 'string' ? c.protocolVersion : '2',
    WIREGUARD_SERVER_PUBLIC_KEY: c.serverPubKey,
    WIREGUARD_PSK: presharedKey,
    SERVER_IP_ADDRESS: server.host,
    AWG_SERVER_PORT: c.port,
  };

  const clientConf = renderTemplate(AWG2_CLIENT_TEMPLATE, templateVars);
  const configJson = renderTemplate(AWG2_CLIENT_JSON_TEMPLATE, templateVars);

  return { config: clientConf, configJson, type: 'awg2' };
}

export async function removeAWG2Client(server: Server, protocol: Protocol, peerId: string): Promise<void> {
  assertContainerName(protocol.container_name);
  await removePeer(server, AWG2_FLAVOR, peerId);
}

// Возвращает ранее отозванного пира с ТЕМ ЖЕ ключом и адресом — снятие
// приостановки по суточному лимиту. Конфиг на руках у клиента при этом
// остаётся рабочим: перевыпускать профиль каждые сутки было бы бессмысленно.
export async function restoreAWG2Client(
  server: Server, protocol: Protocol,
  peer: { clientPubKey: string; presharedKey: string; clientIp: string },
): Promise<void> {
  assertContainerName(protocol.container_name);
  await assertContainerRunning(server, AWG2_FLAVOR);
  await addPeer(server, AWG2_FLAVOR, peer);
}
