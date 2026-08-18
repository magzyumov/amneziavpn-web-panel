import { exec, execSudo } from '../ssh.js';
import {
  assertContainerName, assertDomain, assertPort, assertXrayPath, assertXhttpMode,
  assertXraySecurity, assertXrayFingerprint, assertXrayFlow, sh,
} from '../shell.js';
import {
  writeRemoteFile, readRemoteFile, readContainerFile, buildImage, renderTemplate,
  assertPortFree, runContainer,
} from './common.js';
import { DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS, XRAY_CLIENT_TEMPLATE } from './dockerfiles.js';
import type { Server, Protocol, AddClientResult, InstallResult, XrayConfig } from '../../types.js';
import { UserError } from '../errors.js';

// Полный набор параметров inbound'а. Всё, кроме порта, меняется на живом
// протоколе через applyXraySettings; порт — только переустановкой, потому что
// он зашит в проброс контейнера (docker run -p).
export interface XraySettings {
  sni: string;
  security: 'reality' | 'none';
  fingerprint: string;
  flow: string;                    // '' | 'xtls-rprx-vision'
  transport: 'tcp' | 'xhttp';
  xhttpHost: string;
  xhttpPath: string;
  xhttpMode: string;
}

export const XRAY_DEFAULT_SNI = 'www.googletagmanager.com';

const LEGACY_DEFAULTS: XraySettings = {
  sni: XRAY_DEFAULT_SNI,
  security: 'reality',
  fingerprint: 'chrome',
  flow: 'xtls-rprx-vision',
  transport: 'tcp',
  xhttpHost: '',
  xhttpPath: '',
  xhttpMode: '',
};

/**
 * Приводит сырые опции к валидному набору и снимает несовместимые комбинации.
 * Правила Xray-core:
 *  - flow=xtls-rprx-vision живёт только в паре security=reality + transport=tcp:
 *    без TLS шифровать нечего, а в xhttp Vision неприменим;
 *  - realitySettings и fingerprint не нужны при security=none;
 *  - xhttpSettings появляются только при transport=xhttp.
 * Чистая функция — вся валидация значений здесь, до похода на сервер.
 */
export function normalizeXraySettings(raw: Record<string, unknown> = {}, base: XraySettings = LEGACY_DEFAULTS): XraySettings {
  const pick = <K extends keyof XraySettings>(key: K): unknown => (raw[key] === undefined || raw[key] === '' ? base[key] : raw[key]);

  const security  = assertXraySecurity(pick('security'));
  const transport = String(pick('transport')) === 'xhttp' ? 'xhttp' : 'tcp';
  const sni       = assertDomain(pick('sni'));

  // Vision несовместим с security=none и с xhttp — молча гасим, а не падаем:
  // пользователь мог переключить транспорт, не трогая flow.
  const flowRaw = assertXrayFlow(pick('flow'));
  const flow = security === 'reality' && transport === 'tcp' ? flowRaw : '';

  const fingerprint = security === 'reality' ? assertXrayFingerprint(pick('fingerprint')) : '';

  if (transport !== 'xhttp') {
    return { sni, security, fingerprint, flow, transport, xhttpHost: '', xhttpPath: '', xhttpMode: '' };
  }
  return {
    sni, security, fingerprint, flow, transport,
    xhttpHost: assertDomain(raw.xhttpHost || base.xhttpHost || sni),
    xhttpPath: assertXrayPath(raw.xhttpPath || base.xhttpPath || '/'),
    xhttpMode: assertXhttpMode(raw.xhttpMode || base.xhttpMode || 'auto'),
  };
}

// Читает настройки из сохранённого конфига протокола. Конфиги, созданные до
// появления выбора, полей security/flow/fingerprint не имеют — для них
// подставляются прежние значения (reality + vision + chrome).
export function settingsFromConfig(config: unknown): XraySettings {
  const c = (typeof config === 'string' ? JSON.parse(config) : config) as Record<string, unknown> | null;
  if (!c) return { ...LEGACY_DEFAULTS };
  return normalizeXraySettings({
    sni: c.sni, security: c.security, fingerprint: c.fingerprint, flow: c.flow,
    transport: c.transport, xhttpHost: c.xhttpHost, xhttpPath: c.xhttpPath, xhttpMode: c.xhttpMode,
  }, LEGACY_DEFAULTS);
}

function xhttpBlock(s: XraySettings): string {
  if (s.transport !== 'xhttp') return '';
  // Блок 'headers' НЕ добавляем — Xray 25.8.3 запрещает "host" внутри headers.
  return `,\n                "xhttpSettings": { "host": "${s.xhttpHost}", "path": "${s.xhttpPath}", "mode": "${s.xhttpMode}" }`;
}

// Переменные для configure-скрипта (server.json). Блок realitySettings серверной
// стороны собирается в самом скрипте — там лежит приватный ключ.
function serverStreamVars(s: XraySettings): Record<string, string> {
  return {
    XRAY_NETWORK: s.transport === 'xhttp' ? 'xhttp' : 'tcp',
    XRAY_SECURITY: s.security,
    XRAY_FLOW_SUFFIX: s.flow ? `, "flow": "${s.flow}"` : '',
    XRAY_XHTTP_BLOCK: xhttpBlock(s),
  };
}

// Переменные для клиентского шаблона.
function clientStreamVars(s: XraySettings, publicKey: string, shortId: string): Record<string, string> {
  const realityBlock = s.security === 'reality'
    ? `,\n            "realitySettings": {\n                "fingerprint": "${s.fingerprint}",\n                "serverName": "${s.sni}",\n                "publicKey": "${publicKey}",\n                "shortId": "${shortId}",\n                "spiderX": ""\n            }`
    : '';
  return {
    XRAY_NETWORK: s.transport === 'xhttp' ? 'xhttp' : 'tcp',
    XRAY_SECURITY: s.security,
    XRAY_REALITY_BLOCK: realityBlock,
    XRAY_FLOW_SUFFIX: s.flow ? `, "flow": "${s.flow}"` : '',
    XRAY_XHTTP_BLOCK: xhttpBlock(s),
  };
}

// vless://-ссылка. Параметры Reality (pbk/sid/fp) добавляются только когда
// security=reality, иначе клиент попытается сделать TLS там, где его нет.
export function buildVlessUrl(
  s: XraySettings, host: string, port: number, clientId: string, name: string,
  publicKey: string, shortId: string,
): string {
  const q: string[] = [`type=${s.transport === 'xhttp' ? 'xhttp' : 'tcp'}`, `security=${s.security}`];
  if (s.security === 'reality') {
    q.push(`pbk=${publicKey}`, `fp=${s.fingerprint}`, `sni=${s.sni}`, `sid=${shortId}`);
  }
  if (s.transport === 'xhttp') {
    q.push(`host=${s.xhttpHost}`, `path=${encodeURIComponent(s.xhttpPath)}`, `mode=${s.xhttpMode}`);
  }
  if (s.flow) q.push(`flow=${s.flow}`);
  return `vless://${clientId}@${host}:${port}?${q.join('&')}#${name}`;
}

// Собирает пару «ссылка + нативный JSON» для клиента. Вынесено отдельно, потому
// что то же самое нужно при смене настроек протокола: uuid клиентов сохраняются,
// перерисовываются только их конфиги.
export function renderXrayClient(server: Server, config: unknown, clientId: string, clientName: string): AddClientResult {
  const c = (typeof config === 'string' ? JSON.parse(config) : config) as any;
  const s = settingsFromConfig(c);
  const port = c?.port;
  const publicKey = c?.publicKey ?? '';
  const shortId = c?.shortId ?? '';

  if (!port) throw new UserError('Xray protocol config is incomplete (missing port). Reinstall the protocol.');
  if (s.security === 'reality' && (!publicKey || !shortId)) {
    throw new UserError('Xray protocol config is incomplete (missing Reality publicKey/shortId). Reinstall the protocol.');
  }

  const safeName = clientName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return {
    config: buildVlessUrl(s, server.host, port, clientId, safeName, publicKey, shortId),
    configJson: renderTemplate(XRAY_CLIENT_TEMPLATE, {
      SERVER_IP_ADDRESS: server.host,
      XRAY_SERVER_PORT: port,
      XRAY_CLIENT_ID: clientId,
      ...clientStreamVars(s, publicKey, shortId),
    }),
    type: 'xray',
  };
}

export const XRAY_CONTAINER = 'amnezia-xray';
export const XRAY_IMAGE = 'amnezia-xray:latest';

// Аргументы docker run — отдельно, чтобы проверка дрейфа могла пересчитать
// ожидаемый отпечаток для уже запущенного контейнера.
export function xrayRunArgs(port: number): string[] {
  return [
    `--name ${XRAY_CONTAINER}`,
    `--restart always`,
    `--privileged`,
    `--log-driver json-file`,
    `--log-opt max-size=10m`,
    `--log-opt max-file=3`,
    `--cap-add NET_ADMIN`,
    `-v /opt/amnezia:/opt/amnezia`,
    `-p ${port}:${port}/tcp`,
    XRAY_IMAGE,
  ];
}

export async function installXray(server: Server, options: Record<string, unknown> = {}): Promise<InstallResult> {
  const port = assertPort(options.port ?? 443);
  const s = normalizeXraySettings(options);
  const containerName = XRAY_CONTAINER;
  const imageName = XRAY_IMAGE;
  const buildDir = '/opt/amnezia/amnezia-xray';

  // Освобождаем порт от своего старого контейнера (переустановка), затем проверяем,
  // что порт не занят кем-то ещё на хосте.
  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await assertPortFree(server, port, containerName);

  await buildImage(server, imageName, buildDir, DOCKERFILES.xray);

  await execSudo(server, `mkdir -p /opt/amnezia/xray`);
  await writeRemoteFile(server, `/opt/amnezia/xray/start.sh`, START_SCRIPTS.xray(port, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/xray/start.sh`);

  await runContainer(server, xrayRunArgs(port));
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);
  await execSudo(server, `docker exec -i ${containerName} bash -c 'mkdir -p /dev/net; if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200; fi'`);

  const vars = serverStreamVars(s);
  const xrayConfigureScript = [
    `export XRAY_SERVER_PORT=${port}`,
    `export XRAY_SITE_NAME=${s.sni}`,
    `export XRAY_NETWORK=${vars.XRAY_NETWORK}`,
    `export XRAY_SECURITY=${vars.XRAY_SECURITY}`,
    `export XRAY_FLOW_SUFFIX=${sh(vars.XRAY_FLOW_SUFFIX)}`,
    `export XRAY_XHTTP_BLOCK=${sh(vars.XRAY_XHTTP_BLOCK)}`,
    '',
    CONFIGURE_SCRIPTS.xray,
  ].join('\n');

  const xrayConfigurePath = '/opt/amnezia/configure_xray.sh';
  await writeRemoteFile(server, xrayConfigurePath, xrayConfigureScript);
  const xrayConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${xrayConfigurePath}`);
  if (xrayConfigureRes.code !== 0) {
    throw new UserError(`Xray configure script failed (exit ${xrayConfigureRes.code}): ${xrayConfigureRes.stderr || xrayConfigureRes.stdout}`);
  }

  const publicKey = await readRemoteFile(server, '/opt/amnezia/xray/xray_public.key');
  const shortId   = await readRemoteFile(server, '/opt/amnezia/xray/xray_short_id.key');
  const firstUuid = await readRemoteFile(server, '/opt/amnezia/xray/xray_uuid.key');
  // Ключи Reality генерятся всегда, даже при security=none — чтобы переключение
  // на reality потом не требовало переустановки.
  if (!publicKey) throw new UserError('Xray configure script did not generate public key');
  if (!shortId)   throw new UserError('Xray configure script did not generate short ID');
  if (!firstUuid) throw new UserError('Xray configure script did not generate UUID');

  const config: XrayConfig = {
    port, publicKey, shortId, firstUuid,
    sni: s.sni, security: s.security, fingerprint: s.fingerprint, flow: s.flow, transport: s.transport,
  };
  if (s.transport === 'xhttp') {
    config.xhttpHost = s.xhttpHost;
    config.xhttpPath = s.xhttpPath;
    config.xhttpMode = s.xhttpMode;
  }
  return { containerName, port, config };
}

// Читает и парсит server.json из контейнера.
async function readServerJson(server: Server, containerName: string): Promise<any> {
  const raw = await readContainerFile(server, containerName, '/opt/amnezia/xray/server.json');
  if (!raw) {
    throw new UserError('Xray server.json not found on VPS. The protocol may not have been configured correctly. Reinstall the protocol.');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UserError(`Failed to parse Xray server.json: ${(e as Error).message}. File content may be corrupted. Reinstall the protocol.`);
  }
}

function vlessInboundOf(serverJson: any): any {
  const inbound = serverJson.inbounds?.find((i: any) => i.protocol === 'vless');
  if (!inbound?.settings?.clients) {
    throw new UserError('Unexpected structure in Xray server.json (no vless inbound). Reinstall the protocol.');
  }
  return inbound;
}

async function writeServerJsonAndRestart(server: Server, containerName: string, serverJson: any): Promise<void> {
  const jsonB64 = Buffer.from(JSON.stringify(serverJson, null, 4)).toString('base64');
  await execSudo(server, `echo '${jsonB64}' | base64 -d | docker exec -i ${containerName} sh -c 'cat > /opt/amnezia/xray/server.json'`);
  const restartRes = await execSudo(server, `docker restart ${containerName}`);
  if (restartRes.code !== 0) {
    throw new UserError(`Failed to restart Xray container: ${restartRes.stderr}`);
  }
}

/**
 * Меняет параметры inbound'а на уже установленном протоколе: security, sni,
 * fingerprint, flow, транспорт. Порт не трогаем — он зашит в проброс контейнера.
 * Клиентские uuid сохраняются, поэтому вызывающему остаётся перерисовать их
 * конфиги через renderXrayClient.
 */
export async function applyXraySettings(server: Server, protocol: Protocol, options: Record<string, unknown>): Promise<XrayConfig> {
  assertContainerName(protocol.container_name);
  const cn = protocol.container_name;
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const s = normalizeXraySettings(options, settingsFromConfig(c));

  const serverJson = await readServerJson(server, cn);
  const inbound = vlessInboundOf(serverJson);

  const stream: any = { network: s.transport === 'xhttp' ? 'xhttp' : 'tcp', security: s.security };
  if (s.security === 'reality') {
    // Приватный ключ живёт только на сервере и в конфиг панели не попадает.
    const privateKey = (await readContainerFile(server, cn, '/opt/amnezia/xray/xray_private.key'))?.trim();
    if (!privateKey) {
      throw new UserError('Reality private key not found on the server. Reinstall the protocol to switch security back to reality.');
    }
    stream.realitySettings = {
      dest: `${s.sni}:443`,
      serverNames: [s.sni],
      privateKey,
      shortIds: [c?.shortId ?? ''],
    };
  }
  if (s.transport === 'xhttp') {
    stream.xhttpSettings = { host: s.xhttpHost, path: s.xhttpPath, mode: s.xhttpMode };
  }
  inbound.streamSettings = stream;

  // flow задаётся на каждом клиенте, а не на inbound'е: при переходе на
  // security=none/xhttp его нужно снять со всех, иначе Xray отвергнет конфиг.
  inbound.settings.clients = inbound.settings.clients.map((client: any) => {
    const next = { ...client };
    if (s.flow) next.flow = s.flow; else delete next.flow;
    return next;
  });

  await writeServerJsonAndRestart(server, cn, serverJson);

  const config: XrayConfig = {
    port: c.port, publicKey: c.publicKey, shortId: c.shortId, firstUuid: c.firstUuid,
    sni: s.sni, security: s.security, fingerprint: s.fingerprint, flow: s.flow, transport: s.transport,
  };
  if (s.transport === 'xhttp') {
    config.xhttpHost = s.xhttpHost;
    config.xhttpPath = s.xhttpPath;
    config.xhttpMode = s.xhttpMode;
  }
  return config;
}

export async function addXrayClient(server: Server, protocol: Protocol, clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new UserError(`Xray container '${cn}' is not running. Start the protocol first.`);
  }

  const uuidRes = await execSudo(server, `docker exec ${cn} xray uuid`);
  if (uuidRes.code !== 0 || !uuidRes.stdout.trim()) {
    throw new UserError(`Failed to generate Xray UUID: ${uuidRes.stderr || 'empty output. Check that xray binary is installed in the container.'}`);
  }
  const clientId = uuidRes.stdout.trim();

  const serverJson = await readServerJson(server, cn);
  const vlessInbound = vlessInboundOf(serverJson);

  const s = settingsFromConfig(c);
  // email == clientId — это то, по чему Xray мапит per-user stats counters.
  const newClient: any = { id: clientId, email: clientId, level: 0 };
  if (s.flow) newClient.flow = s.flow;
  vlessInbound.settings.clients.push(newClient);

  await writeServerJsonAndRestart(server, cn, serverJson);
  return renderXrayClient(server, c, clientId, clientName);
}

// Возвращает ранее отозванного клиента в server.json с тем же uuid — снятие
// приостановки по суточному лимиту. Выданная клиенту vless://-ссылка остаётся
// рабочей, потому что uuid не меняется.
export async function restoreXrayClient(server: Server, protocol: Protocol, peerId: string): Promise<void> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  const serverJson = await readServerJson(server, cn);
  const vlessInbound = vlessInboundOf(serverJson);
  // Уже на месте — значит приостановка не доехала до сервера. Рестарт ради
  // ничего не делаем: он рвёт соединения всем остальным клиентам.
  if (vlessInbound.settings.clients.some((x: any) => x.id === peerId)) return;

  const s = settingsFromConfig(c);
  const restored: any = { id: peerId, email: peerId, level: 0 };
  if (s.flow) restored.flow = s.flow;
  vlessInbound.settings.clients.push(restored);

  await writeServerJsonAndRestart(server, cn, serverJson);
}

// Отзыв клиента: убираем VLESS-клиента (по uuid) из server.json и рестартим (peerId = uuid).
export async function removeXrayClient(server: Server, protocol: Protocol, peerId: string): Promise<void> {
  assertContainerName(protocol.container_name);
  const cn = protocol.container_name;
  const confRaw = await readContainerFile(server, cn, '/opt/amnezia/xray/server.json');
  if (!confRaw) return;
  let serverJson: any;
  try { serverJson = JSON.parse(confRaw); } catch { return; }
  const vlessInbound = serverJson.inbounds?.find((i: any) => i.protocol === 'vless');
  if (!vlessInbound?.settings?.clients) return;
  const before = vlessInbound.settings.clients.length;
  vlessInbound.settings.clients = vlessInbound.settings.clients.filter((c: any) => c.id !== peerId);
  if (vlessInbound.settings.clients.length === before) return; // нечего удалять

  await writeServerJsonAndRestart(server, cn, serverJson);
}
