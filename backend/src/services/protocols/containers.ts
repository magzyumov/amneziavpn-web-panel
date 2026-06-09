import { exec, execSudo } from '../ssh.js';
import { assertContainerName, shInt } from '../shell.js';
import { readContainerFile } from './common.js';
import type { Server, ProtocolType, ExecResult } from '../../types.js';

export async function getContainerStatus(server: Server, containerName: string): Promise<string> {
  assertContainerName(containerName);
  const res = await exec(server, `docker inspect --format='{{.State.Status}}' ${containerName} 2>/dev/null || echo "not_found"`);
  return res.stdout.trim();
}

export async function getContainersHealth(server: Server, containerNames: string[]): Promise<Record<string, string>> {
  if (!containerNames.length) return {};
  for (const c of containerNames) assertContainerName(c);
  const list = containerNames.map(c => `"${c}"`).join(' ');
  const cmd = `for c in ${list}; do echo "$c:$(docker inspect --format='{{.State.Status}}' $c 2>/dev/null || echo 'not_found')"; done`;
  const res = await exec(server, cmd);
  const result: Record<string, string> = {};
  for (const line of res.stdout.trim().split('\n')) {
    const idx = line.lastIndexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const status = line.slice(idx + 1).trim() || 'not_found';
    if (name) result[name] = status;
  }
  return result;
}

export async function startContainer(server: Server, containerName: string): Promise<ExecResult> {
  assertContainerName(containerName);
  return execSudo(server, `docker start ${containerName}`);
}

export async function stopContainer(server: Server, containerName: string): Promise<ExecResult> {
  assertContainerName(containerName);
  return execSudo(server, `docker stop ${containerName}`);
}

export async function removeContainer(server: Server, containerName: string): Promise<ExecResult> {
  assertContainerName(containerName);
  return execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
}

export async function getContainerLogs(server: Server, containerName: string, lines: number = 100): Promise<string> {
  assertContainerName(containerName);
  const safeLines = shInt(lines, { min: 1, max: 10000, label: 'lines' });
  const res = await execSudo(server, `docker logs --tail ${safeLines} ${containerName} 2>&1`);
  return res.stdout;
}

export interface AmneziaContainerListing { name: string; status: string; image: string }

export async function listAmneziaContainers(server: Server): Promise<AmneziaContainerListing[]> {
  const res = await exec(server, `docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep amnezia 2>/dev/null || true`);
  if (!res.stdout.trim()) return [];
  return res.stdout.trim().split('\n').map(line => {
    const [name, status, image] = line.split('\t');
    return { name: (name || '').trim(), status: (status || '').trim(), image: (image || '').trim() };
  });
}

export async function ensureDocker(server: Server): Promise<boolean> {
  const check = await exec(server, 'docker --version 2>/dev/null');
  if (check.code === 0) return true;
  await execSudo(server, 'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker');
  return true;
}

export interface ScannedClient { clientId: string; name: string }
export interface ScannedProtocol {
  type: ProtocolType;
  containerName: string;
  status: string;
  port: number | null;
  config: Record<string, unknown>;
  clients: ScannedClient[];
}

// Сканирует /opt/amnezia/<proto>/* контейнеров AWG/WG/Xray и восстанавливает их конфиг.
export async function scanExistingProtocols(server: Server): Promise<ScannedProtocol[]> {
  const found: ScannedProtocol[] = [];

  const candidates: Array<{ type: ProtocolType; containerName: string; confDir: string }> = [
    { type: 'awg2',      containerName: 'amnezia-awg2',      confDir: '/opt/amnezia/awg' },
    { type: 'wireguard', containerName: 'amnezia-wireguard',  confDir: '/opt/amnezia/wireguard' },
    { type: 'xray',      containerName: 'amnezia-xray',       confDir: '/opt/amnezia/xray' },
  ];

  for (const c of candidates) {
    const statusRes = await execSudo(server, `docker inspect --format='{{.State.Status}}' ${c.containerName} 2>/dev/null || echo 'not_found'`);
    const status = statusRes.stdout.trim();
    if (status === 'not_found') continue;

    let config: Record<string, unknown> = {};
    let port: number | null = null;

    if (c.type === 'awg2') {
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/wireguard_server_public_key.key`);
      const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/awg0.conf`);
      if (!pubKey && !confRaw) continue;
      const portMatch = confRaw.match(/ListenPort\s*=\s*(\d+)/);
      port = portMatch ? parseInt(portMatch[1]) : null;
      // #? — I1-I5 хранятся закомментированными в серверном конфиге Amnezia Desktop.
      // [ \t]* — не поглощаем \n.  .* — разрешаем пустые значения.
      const getConf = (key: string): string | null => {
        const m = confRaw.match(new RegExp(`^#?[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
        return m ? m[1].trim() : null;
      };
      config = {
        port,
        subnetIp: '10.8.1.0', subnetCidr: '24',
        serverPubKey: pubKey,
        jc: getConf('Jc'), jmin: getConf('Jmin'), jmax: getConf('Jmax'),
        s1: getConf('S1'), s2: getConf('S2'), s3: getConf('S3'), s4: getConf('S4'),
        h1: getConf('H1'), h2: getConf('H2'), h3: getConf('H3'), h4: getConf('H4'),
        i1: getConf('I1') ?? '', i2: getConf('I2') ?? '', i3: getConf('I3') ?? '',
        i4: getConf('I4') ?? '', i5: getConf('I5') ?? '',
      };
    } else if (c.type === 'wireguard') {
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/wireguard_server_public_key.key`);
      const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/wg0.conf`);
      if (!pubKey && !confRaw) continue;
      const portMatch = confRaw.match(/ListenPort\s*=\s*(\d+)/);
      port = portMatch ? parseInt(portMatch[1]) : null;
      config = { port, subnetIp: '10.8.1.0', subnetCidr: '24', serverPubKey: pubKey };
    } else if (c.type === 'xray') {
      let serverJson: any = null;
      try {
        const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/server.json`);
        serverJson = JSON.parse(confRaw);
      } catch { continue; }
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/xray_public.key`);
      const shortId = await readContainerFile(server, c.containerName, `${c.confDir}/xray_short_id.key`);
      const uuid    = await readContainerFile(server, c.containerName, `${c.confDir}/xray_uuid.key`);
      // Со stats-конфигом inbounds[0] — это api на localhost; vless ищем по протоколу.
      const vlessInbound = serverJson?.inbounds?.find((i: any) => i?.protocol === 'vless') || serverJson?.inbounds?.[0];
      port = vlessInbound?.port || null;
      const sni = vlessInbound?.streamSettings?.realitySettings?.dest?.replace(/:443$/, '') || '';
      config = { port, sni, publicKey: pubKey, shortId, firstUuid: uuid };
    }

    let clients: ScannedClient[] = [];
    try {
      const raw = await readContainerFile(server, c.containerName, `${c.confDir}/clientsTable`);
      const table: Array<{ clientId: string; userData?: { clientName?: string } }> = JSON.parse(raw);
      clients = table.map(e => ({
        clientId: e.clientId,
        name: e.userData?.clientName || `client-${String(e.clientId).slice(0, 8)}`,
      }));
    } catch { /* ignore */ }

    found.push({ type: c.type, containerName: c.containerName, status, port, config, clients });
  }

  return found;
}

export const PROTOCOLS: Record<ProtocolType, { name: string; description: string; icon: string }> = {
  awg2:      { name: 'AmneziaWG 2.0',     description: 'WireGuard + расширенная обфускация DPI',  icon: '🛡️' },
  xray:      { name: 'Xray VLESS Reality', description: 'VLESS + Reality — имитирует TLS трафик',  icon: '⚡' },
  wireguard: { name: 'WireGuard',          description: 'Классический WireGuard без обфускации',   icon: '🔒' },
  mtproxy:   { name: 'MTProxy',            description: 'Telegram MTProto-прокси (только Telegram)', icon: '✈️' },
  telemt:    { name: 'Telemt',             description: 'Telegram-прокси с FakeTLS-маскировкой',    icon: '📨' },
};
