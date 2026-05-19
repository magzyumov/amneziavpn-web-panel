import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertPort } from '../shell.js';
import {
  randPort,
  writeRemoteFile, readRemoteFile, readContainerFile, buildImage, renderTemplate,
} from './common.js';
import {
  DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS,
  WG_CLIENT_TEMPLATE, WG_CLIENT_JSON_TEMPLATE,
} from './dockerfiles.js';
import type { Server, Protocol, AddClientResult, InstallResult, WireGuardConfig } from '../../types.js';

interface WgInstallOptions { port?: number }

export async function installWireGuard(server: Server, options: WgInstallOptions = {}): Promise<InstallResult> {
  const port      = assertPort(options.port || randPort());
  const subnetIp  = '10.8.1.0';
  const subnetCidr = '24';
  const containerName = 'amnezia-wireguard';
  const imageName = 'amnezia-wireguard:latest';
  const buildDir  = '/opt/amnezia/amnezia-wireguard';

  await buildImage(server, imageName, buildDir, DOCKERFILES.wireguard);

  await execSudo(server, `mkdir -p /opt/amnezia/wireguard`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.wireguard(subnetIp, subnetCidr, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/start.sh`);

  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
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
  await execSudo(server, `docker network create amnezia-dns-net 2>/dev/null || true`);
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);

  const wgConfigureScript = [
    `export WIREGUARD_SUBNET_IP=${subnetIp}`,
    `export WIREGUARD_SUBNET_CIDR=${subnetCidr}`,
    `export WIREGUARD_SERVER_PORT=${port}`,
    '',
    CONFIGURE_SCRIPTS.wireguard,
  ].join('\n');

  const wgConfigurePath = '/opt/amnezia/configure_wg.sh';
  await writeRemoteFile(server, wgConfigurePath, wgConfigureScript);
  const wgConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${wgConfigurePath}`);
  if (wgConfigureRes.code !== 0) {
    throw new Error(`WireGuard configure script failed (exit ${wgConfigureRes.code}): ${wgConfigureRes.stderr || wgConfigureRes.stdout}`);
  }

  const serverPubKey = await readRemoteFile(server, '/opt/amnezia/wireguard/wireguard_server_public_key.key');
  if (!serverPubKey) throw new Error('WireGuard configure script did not generate server public key');

  const config: WireGuardConfig = { port, subnetIp, subnetCidr, serverPubKey };
  return { containerName, port, config };
}

export async function addWireGuardClient(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new Error('WireGuard protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`WireGuard container '${cn}' is not running. Start the protocol first.`);
  }

  const privRes = await execSudo(server, `docker exec ${cn} wg genkey`);
  if (privRes.code !== 0 || !privRes.stdout.trim()) {
    throw new Error(`Failed to generate WireGuard client private key: ${privRes.stderr || 'empty output'}`);
  }
  const clientPrivKey = privRes.stdout.trim();

  const pubRes = await execSudo(server, `echo '${clientPrivKey}' | docker exec -i ${cn} wg pubkey`);
  if (pubRes.code !== 0 || !pubRes.stdout.trim()) {
    throw new Error(`Failed to generate WireGuard client public key: ${pubRes.stderr || 'empty output'}`);
  }
  const clientPubKey = pubRes.stdout.trim();

  const presharedKey = await readContainerFile(server, cn, '/opt/amnezia/wireguard/wireguard_psk.key');
  if (!presharedKey) {
    throw new Error('WireGuard PSK not found on server. Reinstall the protocol.');
  }

  const peersRes = await execSudo(server, `docker exec ${cn} wg show wg0 peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  const clientIp = `10.8.1.${peerCount + 2}`;

  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${cn} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);
  const addPeerRes = await execSudo(server, `docker exec ${cn} sh -c "wg set wg0 peer ${clientPubKey} preshared-key ${pskTmp} allowed-ips ${clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new Error(`Failed to add WireGuard peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  const wgPeerEntry = Buffer.from(`\n[Peer]\nPublicKey = ${clientPubKey}\nPresharedKey = ${presharedKey}\nAllowedIPs = ${clientIp}/32\n`).toString('base64');
  await execSudo(server, `echo '${wgPeerEntry}' | base64 -d | docker exec -i ${cn} tee -a /opt/amnezia/wireguard/wg0.conf > /dev/null`);

  const templateVars: Record<string, string | number> = {
    WIREGUARD_CLIENT_IP: clientIp,
    PRIMARY_DNS: '1.1.1.1',
    SECONDARY_DNS: '8.8.8.8',
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
    WIREGUARD_CLIENT_PUBLIC_KEY: clientPubKey,
    WIREGUARD_SERVER_PUBLIC_KEY: c.serverPubKey,
    WIREGUARD_PSK: presharedKey,
    SERVER_IP_ADDRESS: server.host,
    WIREGUARD_SERVER_PORT: c.port,
  };

  const clientConf = renderTemplate(WG_CLIENT_TEMPLATE, templateVars);
  const configJson = renderTemplate(WG_CLIENT_JSON_TEMPLATE, templateVars);

  return { config: clientConf, configJson, type: 'wireguard' };
}
