// Barrel-файл для сервисов протоколов.
// Внешний код импортирует всё отсюда: `from './services/protocols/index.js'`.

export { installAWG2, addAWG2Client } from './awg2.js';
export { installXray, addXrayClient } from './xray.js';
export { installWireGuard, addWireGuardClient } from './wireguard.js';
export {
  getContainerStatus, getContainersHealth, startContainer, stopContainer,
  removeContainer, getContainerLogs, listAmneziaContainers, ensureDocker,
  scanExistingProtocols, PROTOCOLS,
} from './containers.js';
export type { AmneziaContainerListing, ScannedProtocol, ScannedClient } from './containers.js';
export { readAwgWgPeerStats } from './stats.js';
export type { PeerStats } from './stats.js';
