import { assertContainerName, assertPort } from '../shell.js';
import { randPort, readContainerFile, renderTemplate } from './common.js';
import {
  DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS,
  WG_CLIENT_TEMPLATE, WG_CLIENT_JSON_TEMPLATE,
} from './dockerfiles.js';
import { resolveClientDns } from './dns.js';
import {
  installWgLike, assertContainerRunning, genPeerKeys, nextClientIp, addPeer, removePeer,
  type WgFlavor,
} from './wgCommon.js';
import { UserError } from '../errors.js';
import type { Server, Protocol, AddClientResult, InstallResult, WireGuardConfig } from '../../types.js';

interface WgInstallOptions { port?: number }

const FLAVOR: WgFlavor = {
  tool: 'wg',
  iface: 'wg0',
  confDir: '/opt/amnezia/wireguard',
  containerName: 'amnezia-wireguard',
  imageName: 'amnezia-wireguard:latest',
  buildDir: '/opt/amnezia/amnezia-wireguard',
  label: 'WireGuard',
};

const SUBNET_PREFIX = '10.8.1';

export async function installWireGuard(server: Server, options: WgInstallOptions = {}): Promise<InstallResult> {
  const port = assertPort(options.port || randPort());
  const subnetIp = `${SUBNET_PREFIX}.0`;
  const subnetCidr = '24';

  const serverPubKey = await installWgLike(server, FLAVOR, {
    port, subnetIp, subnetCidr,
    dockerfile: DOCKERFILES.wireguard,
    startScript: START_SCRIPTS.wireguard(subnetIp, subnetCidr, server.host),
    configureScript: [
      `export WIREGUARD_SUBNET_IP=${subnetIp}`,
      `export WIREGUARD_SUBNET_CIDR=${subnetCidr}`,
      `export WIREGUARD_SERVER_PORT=${port}`,
      '',
      CONFIGURE_SCRIPTS.wireguard,
    ].join('\n'),
    configurePath: '/opt/amnezia/configure_wg.sh',
    serverPubKeyPath: `${FLAVOR.confDir}/wireguard_server_public_key.key`,
  });

  const config: WireGuardConfig = { port, subnetIp, subnetCidr, serverPubKey };
  return { containerName: FLAVOR.containerName, port, config };
}

export async function addWireGuardClient(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;

  if (!c.serverPubKey || !c.port) {
    throw new UserError('WireGuard protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  await assertContainerRunning(server, FLAVOR);
  const { clientPrivKey, clientPubKey } = await genPeerKeys(server, FLAVOR);

  // В отличие от AmneziaWG здесь PSK общий для сервера — его создаёт
  // configure-скрипт при установке, а не выпуск каждого клиента.
  const presharedKey = await readContainerFile(server, FLAVOR.containerName, `${FLAVOR.confDir}/wireguard_psk.key`);
  if (!presharedKey) {
    throw new UserError('WireGuard PSK not found on server. Reinstall the protocol.');
  }

  const clientIp = await nextClientIp(server, FLAVOR, SUBNET_PREFIX);
  await addPeer(server, FLAVOR, { clientPubKey, presharedKey, clientIp });

  const clientDns = await resolveClientDns(server);
  const templateVars: Record<string, string | number> = {
    WIREGUARD_CLIENT_IP: clientIp,
    CLIENT_DNS: clientDns,
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
    WIREGUARD_CLIENT_PUBLIC_KEY: clientPubKey,
    WIREGUARD_SERVER_PUBLIC_KEY: c.serverPubKey,
    WIREGUARD_PSK: presharedKey,
    SERVER_IP_ADDRESS: server.host,
    WIREGUARD_SERVER_PORT: c.port,
  };

  return {
    config: renderTemplate(WG_CLIENT_TEMPLATE, templateVars),
    configJson: renderTemplate(WG_CLIENT_JSON_TEMPLATE, templateVars),
    type: 'wireguard',
  };
}

export async function removeWireGuardClient(server: Server, protocol: Protocol, peerId: string): Promise<void> {
  assertContainerName(protocol.container_name);
  await removePeer(server, FLAVOR, peerId);
}
