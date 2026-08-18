// Barrel-файл для сервисов протоколов.
// Внешний код импортирует всё отсюда: `from './services/protocols/index.js'`.

export { installAWG2, addAWG2Client, removeAWG2Client, restoreAWG2Client } from './awg2.js';
export {
  installXray, addXrayClient, removeXrayClient, restoreXrayClient,
  applyXraySettings, renderXrayClient, settingsFromConfig as xraySettingsFromConfig,
} from './xray.js';
export type { XraySettings } from './xray.js';
export { installWireGuard, addWireGuardClient, removeWireGuardClient, restoreWireGuardClient } from './wireguard.js';
export { installTelemt, addTelemtClient, removeTelemtClient, restoreTelemtClient } from './telemt.js';
export {
  getContainerStatus, getContainersHealth, startContainer, stopContainer,
  removeContainer, getContainerLogs, listAmneziaContainers, ensureDocker,
  updateAndRebootHost, scanExistingProtocols, PROTOCOLS,
} from './containers.js';
export type { AmneziaContainerListing, ScannedProtocol, ScannedClient } from './containers.js';
export { readAwgWgPeerStats, readXrayPeerStats, readTelemtPeerStats, withIdleXrayPeers, isXrayStatsEnabled, enableXrayStats } from './stats.js';
export type { PeerStats } from './stats.js';
export { installDns, removeDns, isDnsRunning, resolveClientDns, AMNEZIA_DNS_IP } from './dns.js';
