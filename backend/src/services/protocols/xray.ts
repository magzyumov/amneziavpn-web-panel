import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertDomain, assertPort } from '../shell.js';
import {
  writeRemoteFile, readRemoteFile, readContainerFile, buildImage, renderTemplate,
} from './common.js';
import { DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS, XRAY_CLIENT_TEMPLATE } from './dockerfiles.js';
import type { Server, Protocol, AddClientResult, InstallResult, XrayConfig } from '../../types.js';

interface XrayInstallOptions { port?: number; sni?: string }

export async function installXray(server: Server, options: XrayInstallOptions = {}): Promise<InstallResult> {
  const port = assertPort(options.port ?? 443);
  const sni  = assertDomain(options.sni ?? 'www.googletagmanager.com');
  const containerName = 'amnezia-xray';
  const imageName = 'amnezia-xray:latest';
  const buildDir = '/opt/amnezia/amnezia-xray';

  await buildImage(server, imageName, buildDir, DOCKERFILES.xray);

  await execSudo(server, `mkdir -p /opt/amnezia/xray`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.xray(port, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/start.sh`);

  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
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
  await execSudo(server, `docker network create amnezia-dns-net 2>/dev/null || true`);
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);
  await execSudo(server, `docker exec -i ${containerName} bash -c 'mkdir -p /dev/net; if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200; fi'`);

  const xrayConfigureScript = [
    `export XRAY_SERVER_PORT=${port}`,
    `export XRAY_SITE_NAME=${sni}`,
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

  const config: XrayConfig = { port, sni, publicKey, shortId, firstUuid };
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

  // email == clientId — это то, по чему Xray мапит per-user stats counters.
  vlessInbound.settings.clients.push({ id: clientId, email: clientId, level: 0, flow: 'xtls-rprx-vision' });

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

  const vlessUrl = `vless://${clientId}@${server.host}:${port}?type=tcp&security=reality&pbk=${pubKey}&fp=chrome&sni=${sni}&sid=${shortId}&flow=xtls-rprx-vision#${safeName}`;

  const clientJson = renderTemplate(XRAY_CLIENT_TEMPLATE, {
    SERVER_IP_ADDRESS: server.host,
    XRAY_SERVER_PORT: port,
    XRAY_CLIENT_ID: clientId,
    XRAY_SITE_NAME: sni,
    XRAY_PUBLIC_KEY: pubKey,
    XRAY_SHORT_ID: shortId,
  });

  return { config: vlessUrl, configJson: clientJson, type: 'xray' };
}
