// Barrel-файл для сервисов протоколов.
// Внешний код импортирует всё отсюда: `from './services/protocols/index.js'`.

export { installAWG2, addAWG2Client, removeAWG2Client } from './awg2.js';
export { installXray, addXrayClient, removeXrayClient } from './xray.js';
export { installWireGuard, addWireGuardClient, removeWireGuardClient } from './wireguard.js';
export { installTelemt, addTelemtClient, removeTelemtClient } from './telemt.js';
export {
  getContainerStatus, getContainersHealth, startContainer, stopContainer,
  removeContainer, getContainerLogs, listAmneziaContainers, ensureDocker,
  scanExistingProtocols, PROTOCOLS,
} from './containers.js';
export type { AmneziaContainerListing, ScannedProtocol, ScannedClient } from './containers.js';
export { readAwgWgPeerStats, readXrayPeerStats, readTelemtPeerStats, isXrayStatsEnabled, enableXrayStats } from './stats.js';
export type { PeerStats } from './stats.js';
export { installDns, removeDns, isDnsRunning, resolveClientDns, AMNEZIA_DNS_IP } from './dns.js';
