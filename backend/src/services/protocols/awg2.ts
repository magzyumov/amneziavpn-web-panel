import { exec, execSudo } from '../ssh.js';
import {
  assertContainerName, assertPort, shInt, assertMagicHeader, assertUint32Range, assertWgKey, sh,
} from '../shell.js';
import {
  randInt, randPort,
  writeRemoteFile, readRemoteFile, buildImage, renderTemplate, assertPortFree, removePeerBlock,
} from './common.js';
import {
  DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS,
  AWG2_CLIENT_TEMPLATE, AWG2_CLIENT_JSON_TEMPLATE,
} from './dockerfiles.js';
import { resolveClientDns } from './dns.js';
import type {
  Server, Protocol, AddClientResult, InstallResult, Awg2Config,
} from '../../types.js';
import { UserError } from '../errors.js';

interface InstallOptions {
  port?: number;
  jc?: number; jmin?: number; jmax?: number;
  s1?: number; s2?: number; s3?: number; s4?: number;
  // H1-H4 в AWG 2.0 — диапазоны "min-max" либо одиночные uint32.
  h1?: number | string; h2?: number | string; h3?: number | string; h4?: number | string;
  // AWG 3.0. headerProtection выключается только явным false (по умолчанию — вкл).
  // Остальные — тип "uint32,range", по умолчанию не задаются (как в апстриме).
  headerProtection?: boolean;
  contentPaddingAddition?: string;
  rekeyAfterTime?: string;
  rekeyTimeout?: string;
  rejectAfterTime?: string;
  keepaliveTimeout?: string;
  maxHandshakeAttempts?: string;
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

// Минимальный размер S1-S4 при включённой header protection: S-паддинг служит
// nonce для шифра заголовков, и amneziawg-go 3.x жёстко требует >= 12 (проверено:
// с S3=5 и заданным HeaderProtectionKey `awg setconf` падает с "Unable to modify
// interface: Invalid argument"). Апстримные нижние границы (s3 от 0, s4 от 0) с
// header protection несовместимы.
const HP_MIN_JUNK = 12;

// Генерация S1-S4 — копия AwgInstaller::generateAwgParameters: значения уникальны
// и не дают совпадающих итоговых размеров пакетов. min поднимается до HP_MIN_JUNK,
// когда включена header protection (AWG 3.0).
function genPacketSizes(min: number): { s1: number; s2: number; s3: number; s4: number } {
  const used = new Set<number>();
  const lo1 = Math.max(15, min), lo3 = Math.max(0, min), lo4 = Math.max(0, min);
  const s1 = randInt(lo1, 149); used.add(s1);
  let s2 = randInt(lo1, 149);
  while (used.has(s2) || s1 + MSG_INIT === s2 + MSG_RESP) s2 = randInt(lo1, 149);
  used.add(s2);
  let s3 = randInt(lo3, 63);
  while (used.has(s3) || s1 + MSG_INIT === s3 + MSG_COOKIE || s2 + MSG_RESP === s3 + MSG_COOKIE) s3 = randInt(lo3, 63);
  used.add(s3);
  let s4 = randInt(lo4, 19);
  while (used.has(s4)) s4 = randInt(lo4, 19);
  return { s1, s2, s3, s4 };
}

// Генерация H1-H4 как диапазонов "min-max" (формат AWG 2.0, AwgInstaller isAwg2).
// Диапазоны возрастающие и непересекающиеся → заголовки гарантированно различны.
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

export async function installAWG2(server: Server, options: InstallOptions = {}): Promise<InstallResult> {
  const port      = assertPort(options.port || randPort());
  const subnetIp  = '10.8.1.0';
  const subnetCidr = '24';
  const containerName = 'amnezia-awg2';
  // Тег включает версию amneziawg-go: buildImage делает ранний выход по существующему
  // образу, поэтому переезд на новую базу возможен только через новый тег.
  const imageName = 'amnezia-awg2:3.0.3';
  const buildDir  = '/opt/amnezia/amnezia-awg2';

  // Параметры обфускации AWG 2.0 — дефолты и алгоритм один-в-один с апстримом
  // (AwgInstaller::generateAwgParameters). Все значения валидируем перед
  // интерполяцией в configure-script.
  const intOpt = (v: number | undefined, fallback: number, label: string): number =>
    v == null ? fallback : shInt(v, { min: 0, max: 4294967295, label });
  const jc   = intOpt(options.jc,   randInt(4, 6), 'jc');   // upstream bounded(4,7)
  const jmin = intOpt(options.jmin, 10,            'jmin');
  const jmax = intOpt(options.jmax, 50,            'jmax');

  // AWG 3.0: header protection включена по умолчанию, выключается явным false.
  const headerProtection = options.headerProtection !== false;

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

  // Клиентские параметры AWG 3.0 — тип "uint32,range". По умолчанию не задаются
  // (апстрим их тоже не генерирует при self-hosted установке).
  const rangeOpt = (v: string | undefined, label: string): string =>
    v == null || v === '' ? '' : assertUint32Range(v, label);
  const contentPaddingAddition = rangeOpt(options.contentPaddingAddition, 'contentPaddingAddition');
  const rekeyAfterTime         = rangeOpt(options.rekeyAfterTime,         'rekeyAfterTime');
  const rekeyTimeout           = rangeOpt(options.rekeyTimeout,           'rekeyTimeout');
  const rejectAfterTime        = rangeOpt(options.rejectAfterTime,        'rejectAfterTime');
  const keepaliveTimeout       = rangeOpt(options.keepaliveTimeout,       'keepaliveTimeout');
  const maxHandshakeAttempts   = rangeOpt(options.maxHandshakeAttempts,   'maxHandshakeAttempts');

  // H1-H4 — диапазоны "min-max" (AWG 2.0). amneziawg-go в образе их поддерживает
  // (формат "%d-%d", h как строка в UAPI).
  const gh = genMagicHeaderRanges();
  const h1 = options.h1 != null ? assertMagicHeader(options.h1, 'h1') : gh[0];
  const h2 = options.h2 != null ? assertMagicHeader(options.h2, 'h2') : gh[1];
  const h3 = options.h3 != null ? assertMagicHeader(options.h3, 'h3') : gh[2];
  const h4 = options.h4 != null ? assertMagicHeader(options.h4, 'h4') : gh[3];

  // Освобождаем порт от своего старого контейнера (переустановка), затем проверяем,
  // что порт не занят кем-то ещё на хосте.
  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await assertPortFree(server, port, containerName);

  await buildImage(server, imageName, buildDir, DOCKERFILES.awg2);

  await execSudo(server, `mkdir -p /opt/amnezia/awg`);
  await writeRemoteFile(server, `/opt/amnezia/awg/start.sh`, START_SCRIPTS.awg2(subnetIp, subnetCidr, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/awg/start.sh`);

  await execSudo(server, [
    `docker run -d`,
    `--log-driver none`,
    `--restart always`,
    `--privileged`,
    `--cap-add=NET_ADMIN`,
    `--cap-add=SYS_MODULE`,
    `-p ${port}:${port}/udp`,
    `-v /lib/modules:/lib/modules`,
    `-v /opt/amnezia:/opt/amnezia`,
    `--sysctl="net.ipv4.conf.all.src_valid_mark=1"`,
    `--name ${containerName}`,
    imageName,
  ].join(' \\\n  '));
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);

  // HeaderProtectionKey (AWG 3.0) генерируем тем же `awg genkey`, что и остальные
  // ключи — внутри уже запущенного контейнера. Это server-side параметр: одно и то
  // же значение уходит и в awg0.conf, и в клиентские конфиги.
  let headerProtectionKey = '';
  if (headerProtection) {
    const hpkRes = await execSudo(server, `docker exec ${containerName} awg genkey`);
    if (hpkRes.code !== 0 || !hpkRes.stdout.trim()) {
      throw new UserError(`Failed to generate AWG3 header protection key: ${hpkRes.stderr || 'empty output'}`);
    }
    headerProtectionKey = assertWgKey(hpkRes.stdout.trim(), 'headerProtectionKey');
  }
  // Пустое значение параметра = ошибка парсинга у awg setconf, поэтому строку
  // либо пишем целиком, либо не пишем вовсе (вместо неё — комментарий).
  const awg3ServerParams = headerProtectionKey
    ? `HeaderProtectionKey = ${headerProtectionKey}`
    : '# AWG 3.0 header protection disabled';

  const awg2ConfigureScript = [
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

  const awg2ConfigurePath = '/opt/amnezia/configure_awg.sh';
  await writeRemoteFile(server, awg2ConfigurePath, awg2ConfigureScript);
  const awg2ConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${awg2ConfigurePath}`);
  if (awg2ConfigureRes.code !== 0) {
    throw new UserError(`AWG2 configure script failed (exit ${awg2ConfigureRes.code}): ${awg2ConfigureRes.stderr || awg2ConfigureRes.stdout}`);
  }

  // start.sh поднимает awg0 только если awg0.conf существует на момент старта
  // контейнера. При установке конфиг создаётся configure-скриптом ПОСЛЕ старта,
  // поэтому интерфейс остаётся не поднятым (awg set падает с "No such device").
  // Перезапускаем — теперь start.sh найдёт awg0.conf и поднимет интерфейс.
  const awg2RestartRes = await execSudo(server, `docker restart ${containerName}`);
  if (awg2RestartRes.code !== 0) {
    throw new UserError(`Failed to restart AWG2 container after configure: ${awg2RestartRes.stderr || awg2RestartRes.stdout}`);
  }

  const serverPubKey = await readRemoteFile(server, '/opt/amnezia/awg/wireguard_server_public_key.key');
  if (!serverPubKey) throw new UserError('AWG2 configure script did not generate server public key');

  const config: Awg2Config = {
    port, subnetIp, subnetCidr, serverPubKey,
    // protocolVersion=3 означает "инсталляция знает про AWG 3.0" — по нему
    // addAWG2Client решает, можно ли писать AWG3-параметры в клиентский конфиг.
    protocolVersion: headerProtection ? '3' : '2',
    jc, jmin, jmax,
    s1, s2, s3, s4,
    h1, h2, h3, h4,
    i1: DEFAULT_I1, i2: '', i3: '', i4: '', i5: '',
    headerProtectionKey,
    contentPaddingAddition, rekeyAfterTime, rekeyTimeout,
    rejectAfterTime, keepaliveTimeout, maxHandshakeAttempts,
  };
  return { containerName, port, config };
}

export async function addAWG2Client(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new UserError('AWG2 protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new UserError(`AWG2 container '${cn}' is not running. Start the protocol first.`);
  }

  const privRes = await execSudo(server, `docker exec ${cn} awg genkey`);
  if (privRes.code !== 0 || !privRes.stdout.trim()) {
    throw new UserError(`Failed to generate AWG2 client private key: ${privRes.stderr || 'empty output'}`);
  }
  const clientPrivKey = privRes.stdout.trim();

  const pubRes = await execSudo(server, `echo '${clientPrivKey}' | docker exec -i ${cn} awg pubkey`);
  if (pubRes.code !== 0 || !pubRes.stdout.trim()) {
    throw new UserError(`Failed to generate AWG2 client public key: ${pubRes.stderr || 'empty output'}`);
  }
  const clientPubKey = pubRes.stdout.trim();

  const pskRes = await execSudo(server, `docker exec ${cn} awg genpsk`);
  const presharedKey = pskRes.stdout.trim();
  if (!presharedKey) {
    throw new UserError('Failed to generate AWG2 PSK: empty output');
  }

  const peersRes = await execSudo(server, `docker exec ${cn} awg show awg0 peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  const clientIp = `10.8.1.${peerCount + 2}`;

  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${cn} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);
  const addPeerRes = await execSudo(server, `docker exec ${cn} sh -c "awg set awg0 peer ${clientPubKey} preshared-key ${pskTmp} allowed-ips ${clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new UserError(`Failed to add AWG2 peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  const awgPeerEntry = Buffer.from(`\n[Peer]\nPublicKey = ${clientPubKey}\nPresharedKey = ${presharedKey}\nAllowedIPs = ${clientIp}/32\n`).toString('base64');
  await execSudo(server, `echo '${awgPeerEntry}' | base64 -d | docker exec -i ${cn} tee -a /opt/amnezia/awg/awg0.conf > /dev/null`);

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

// Отзыв клиента: убираем peer из живого awg0 и из awg0.conf (peerId = pubkey).
export async function removeAWG2Client(server: Server, protocol: Protocol, peerId: string): Promise<void> {
  assertContainerName(protocol.container_name);
  const cn = protocol.container_name;
  await execSudo(server, `docker exec ${cn} awg set awg0 peer ${sh(peerId)} remove 2>/dev/null || true`);
  const conf = await readRemoteFile(server, '/opt/amnezia/awg/awg0.conf');
  if (conf) {
    await writeRemoteFile(server, '/opt/amnezia/awg/awg0.conf', removePeerBlock(conf, peerId));
  }
}
