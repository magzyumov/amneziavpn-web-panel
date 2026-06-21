import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertDomain, assertPort, assertXrayPath, assertXhttpMode, sh } from '../shell.js';
import {
  writeRemoteFile, readRemoteFile, readContainerFile, buildImage, renderTemplate, assertPortFree,
} from './common.js';
import { DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS, XRAY_CLIENT_TEMPLATE } from './dockerfiles.js';
import type { Server, Protocol, AddClientResult, InstallResult, XrayConfig } from '../../types.js';

interface XrayInstallOptions {
  port?: number;
  sni?: string;
  transport?: 'tcp' | 'xhttp';
  xhttpHost?: string;
  xhttpPath?: string;
  xhttpMode?: string;
}

interface XrayTransport {
  transport: 'tcp' | 'xhttp';
  xhttpHost: string;
  xhttpPath: string;
  xhttpMode: string;
}

// Шаблонные переменные streamSettings для server.json / client config.
// tcp (raw): flow=xtls-rprx-vision, без xhttpSettings.
// xhttp (SplitHTTP): без flow (vision несовместим), + xhttpSettings {host,path,mode}.
// Блок 'headers' НЕ добавляем — Xray 25.8.3 запрещает "host" внутри headers.
function xrayStreamVars(t: XrayTransport): { XRAY_NETWORK: string; XRAY_FLOW_SUFFIX: string; XRAY_XHTTP_BLOCK: string } {
  if (t.transport === 'xhttp') {
    return {
      XRAY_NETWORK: 'xhttp',
      XRAY_FLOW_SUFFIX: '',
      XRAY_XHTTP_BLOCK: `,\n                "xhttpSettings": { "host": "${t.xhttpHost}", "path": "${t.xhttpPath}", "mode": "${t.xhttpMode}" }`,
    };
  }
  return { XRAY_NETWORK: 'tcp', XRAY_FLOW_SUFFIX: ', "flow": "xtls-rprx-vision"', XRAY_XHTTP_BLOCK: '' };
}

// Достаёт и валидирует параметры транспорта из сохранённого конфига протокола.
function transportFromConfig(c: any, sni: string): XrayTransport {
  if (c.transport === 'xhttp') {
    return {
      transport: 'xhttp',
      xhttpHost: assertDomain(c.xhttpHost || sni),
      xhttpPath: assertXrayPath(c.xhttpPath || '/'),
      xhttpMode: assertXhttpMode(c.xhttpMode || 'auto'),
    };
  }
  return { transport: 'tcp', xhttpHost: '', xhttpPath: '', xhttpMode: '' };
}

export async function installXray(server: Server, options: XrayInstallOptions = {}): Promise<InstallResult> {
  const port = assertPort(options.port ?? 443);
  const sni  = assertDomain(options.sni ?? 'www.googletagmanager.com');

  // Транспорт поверх Reality. По умолчанию tcp (как в оригинальном AmneziaVPN).
  const transport: 'tcp' | 'xhttp' = options.transport === 'xhttp' ? 'xhttp' : 'tcp';
  const tvars: XrayTransport = transport === 'xhttp'
    ? {
        transport,
        xhttpHost: assertDomain(options.xhttpHost ?? sni),
        xhttpPath: assertXrayPath(options.xhttpPath ?? '/'),
        xhttpMode: assertXhttpMode(options.xhttpMode ?? 'auto'),
      }
    : { transport, xhttpHost: '', xhttpPath: '', xhttpMode: '' };
  const streamVars = xrayStreamVars(tvars);

  const containerName = 'amnezia-xray';
  const imageName = 'amnezia-xray:latest';
  const buildDir = '/opt/amnezia/amnezia-xray';

  // Освобождаем порт от своего старого контейнера (переустановка), затем проверяем,
  // что порт не занят кем-то ещё на хосте.
  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await assertPortFree(server, port, containerName);

  await buildImage(server, imageName, buildDir, DOCKERFILES.xray);

  await execSudo(server, `mkdir -p /opt/amnezia/xray`);
  await writeRemoteFile(server, `/opt/amnezia/xray/start.sh`, START_SCRIPTS.xray(port, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/xray/start.sh`);

  await execSudo(server, [
    `docker run -d`,
    `--name ${containerName}`,
    `--restart always`,
    `--privileged`,
    `--log-driver none`,
    `--cap-add NET_ADMIN`,
    `-v /opt/amnezia:/opt/amnezia`,
    `-p ${port}:${port}/tcp`,
    imageName,
  ].join(' \\\n  '));
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);
  await execSudo(server, `docker exec -i ${containerName} bash -c 'mkdir -p /dev/net; if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200; fi'`);

  const xrayConfigureScript = [
    `export XRAY_SERVER_PORT=${port}`,
    `export XRAY_SITE_NAME=${sni}`,
    `export XRAY_NETWORK=${streamVars.XRAY_NETWORK}`,
    `export XRAY_FLOW_SUFFIX=${sh(streamVars.XRAY_FLOW_SUFFIX)}`,
    `export XRAY_XHTTP_BLOCK=${sh(streamVars.XRAY_XHTTP_BLOCK)}`,
    '',
    CONFIGURE_SCRIPTS.xray,
  ].join('\n');

  const xrayConfigurePath = '/opt/amnezia/configure_xray.sh';
  await writeRemoteFile(server, xrayConfigurePath, xrayConfigureScript);
  const xrayConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${xrayConfigurePath}`);
  if (xrayConfigureRes.code !== 0) {
    throw new Error(`Xray configure script failed (exit ${xrayConfigureRes.code}): ${xrayConfigureRes.stderr || xrayConfigureRes.stdout}`);
  }

  const publicKey = await readRemoteFile(server, '/opt/amnezia/xray/xray_public.key');
  const shortId   = await readRemoteFile(server, '/opt/amnezia/xray/xray_short_id.key');
  const firstUuid = await readRemoteFile(server, '/opt/amnezia/xray/xray_uuid.key');
  if (!publicKey) throw new Error('Xray configure script did not generate public key');
  if (!shortId)   throw new Error('Xray configure script did not generate short ID');
  if (!firstUuid) throw new Error('Xray configure script did not generate UUID');

  const config: XrayConfig = { port, sni, publicKey, shortId, firstUuid, transport };
  if (transport === 'xhttp') {
    config.xhttpHost = tvars.xhttpHost;
    config.xhttpPath = tvars.xhttpPath;
    config.xhttpMode = tvars.xhttpMode;
  }
  return { containerName, port, config };
}

export async function addXrayClient(server: Server, protocol: Protocol, clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`Xray container '${cn}' is not running. Start the protocol first.`);
  }

  const uuidRes = await execSudo(server, `docker exec ${cn} xray uuid`);
  if (uuidRes.code !== 0 || !uuidRes.stdout.trim()) {
    throw new Error(`Failed to generate Xray UUID: ${uuidRes.stderr || 'empty output. Check that xray binary is installed in the container.'}`);
  }
  const clientId = uuidRes.stdout.trim();

  const confRaw = await readContainerFile(server, cn, '/opt/amnezia/xray/server.json');
  if (!confRaw) {
    throw new Error('Xray server.json not found on VPS. The protocol may not have been configured correctly. Reinstall the protocol.');
  }

  let serverJson: any;
  try {
    serverJson = JSON.parse(confRaw);
  } catch (e) {
    throw new Error(`Failed to parse Xray server.json: ${(e as Error).message}. File content may be corrupted. Reinstall the protocol.`);
  }

  // Со включёнными stats в server.json два inbound'а (api на 127.0.0.1:10085 +
  // vless), без stats — один (vless). Ищем нужный по protocol.
  const vlessInbound = serverJson.inbounds?.find((i: any) => i.protocol === 'vless');
  if (!vlessInbound?.settings?.clients) {
    throw new Error('Unexpected structure in Xray server.json (no vless inbound). Reinstall the protocol.');
  }

  // Транспорт из сохранённого конфига определяет наличие flow:
  // tcp → xtls-rprx-vision, xhttp → без flow (vision несовместим с xhttp).
  const tvars = transportFromConfig(c, c.sni);

  // email == clientId — это то, по чему Xray мапит per-user stats counters.
  const newClient: any = { id: clientId, email: clientId, level: 0 };
  if (tvars.transport === 'tcp') newClient.flow = 'xtls-rprx-vision';
  vlessInbound.settings.clients.push(newClient);

  const jsonB64 = Buffer.from(JSON.stringify(serverJson, null, 4)).toString('base64');
  await execSudo(server, `echo '${jsonB64}' | base64 -d | docker exec -i ${cn} sh -c 'cat > /opt/amnezia/xray/server.json'`);

  const restartRes = await execSudo(server, `docker restart ${cn}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart Xray container: ${restartRes.stderr}`);
  }

  const safeName = clientName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const port    = c.port;
  const sni     = c.sni;
  const pubKey  = c.publicKey;
  const shortId = c.shortId;

  if (!port || !sni || !pubKey || !shortId) {
    throw new Error('Xray protocol config is incomplete (missing port/sni/publicKey/shortId). Reinstall the protocol.');
  }

  const streamVars = xrayStreamVars(tvars);
  const vlessUrl = tvars.transport === 'xhttp'
    ? `vless://${clientId}@${server.host}:${port}?type=xhttp&security=reality&pbk=${pubKey}&fp=chrome&sni=${sni}&sid=${shortId}&host=${tvars.xhttpHost}&path=${encodeURIComponent(tvars.xhttpPath)}&mode=${tvars.xhttpMode}#${safeName}`
    : `vless://${clientId}@${server.host}:${port}?type=tcp&security=reality&pbk=${pubKey}&fp=chrome&sni=${sni}&sid=${shortId}&flow=xtls-rprx-vision#${safeName}`;

  const clientJson = renderTemplate(XRAY_CLIENT_TEMPLATE, {
    SERVER_IP_ADDRESS: server.host,
    XRAY_SERVER_PORT: port,
    XRAY_CLIENT_ID: clientId,
    XRAY_SITE_NAME: sni,
    XRAY_PUBLIC_KEY: pubKey,
    XRAY_SHORT_ID: shortId,
    XRAY_NETWORK: streamVars.XRAY_NETWORK,
    XRAY_FLOW_SUFFIX: streamVars.XRAY_FLOW_SUFFIX,
    XRAY_XHTTP_BLOCK: streamVars.XRAY_XHTTP_BLOCK,
  });

  return { config: vlessUrl, configJson: clientJson, type: 'xray' };
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

  const jsonB64 = Buffer.from(JSON.stringify(serverJson, null, 4)).toString('base64');
  await execSudo(server, `echo '${jsonB64}' | base64 -d | docker exec -i ${cn} sh -c 'cat > /opt/amnezia/xray/server.json'`);
  const restartRes = await execSudo(server, `docker restart ${cn}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart Xray container after client removal: ${restartRes.stderr}`);
  }
}
