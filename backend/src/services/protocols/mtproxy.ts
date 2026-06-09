import { randomBytes } from 'node:crypto';
import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertPort, assertDomain } from '../shell.js';
import { randPort, writeRemoteFile, buildImage } from './common.js';
import { DOCKERFILES, START_SCRIPTS } from './dockerfiles.js';
import type { Server, Protocol, AddClientResult, InstallResult, MtproxyConfig } from '../../types.js';

interface MtproxyInstallOptions { port?: number; tlsDomain?: string }

// Строит ссылку tg://proxy (через https://t.me/proxy — QR-дружелюбно).
// FakeTLS: ee<secret><domain-hex>. Secure mode: dd<secret>.
export function buildMtprotoLink(host: string, port: number, secret: string, tlsDomain: string): string {
  const linkSecret = tlsDomain
    ? `ee${secret}${Buffer.from(tlsDomain, 'utf8').toString('hex')}`
    : `dd${secret}`;
  return `https://t.me/proxy?server=${host}&port=${port}&secret=${linkSecret}`;
}

export async function installMtproxy(server: Server, options: MtproxyInstallOptions = {}): Promise<InstallResult> {
  const port = assertPort(options.port || randPort());
  const tlsDomain = options.tlsDomain ? assertDomain(options.tlsDomain) : '';
  const containerName = 'amnezia-mtproxy';
  const imageName = 'amnezia-mtproxy:latest';
  const buildDir = '/opt/amnezia/amnezia-mtproxy';

  await buildImage(server, imageName, buildDir, DOCKERFILES.mtproxy);

  await execSudo(server, `mkdir -p /opt/amnezia/mtproxy`);
  // Свой start.sh (отдельный путь от общего /opt/amnezia/start.sh других протоколов).
  await writeRemoteFile(server, `/opt/amnezia/mtproxy/start.sh`, START_SCRIPTS.mtproxy(port, tlsDomain));
  await execSudo(server, `chmod +x /opt/amnezia/mtproxy/start.sh`);
  await execSudo(server, `touch /opt/amnezia/mtproxy/secrets`);

  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await execSudo(server, [
    `docker run -d`,
    `--name ${containerName}`,
    `--restart always`,
    `--log-driver none`,
    `-v /opt/amnezia:/opt/amnezia`,
    `-p ${port}:${port}/tcp`,
    imageName,
  ].join(' \\\n  '));

  const config: MtproxyConfig = { port, tlsDomain };
  return { containerName, port, config };
}

export async function addMtproxyClient(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.port) {
    throw new Error('MTProxy protocol config is incomplete (missing port). Reinstall the protocol.');
  }

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`MTProxy container '${cn}' is not running. Start the protocol first.`);
  }

  // 16 байт = 32 hex-символа — формат секрета MTProto.
  const secret = randomBytes(16).toString('hex');

  // Дописываем секрет в файл (host-mounted), затем рестартим, чтобы start.sh
  // подхватил его в -S аргументах.
  await execSudo(server, `printf '%s\\n' '${secret}' >> /opt/amnezia/mtproxy/secrets`);
  const restartRes = await execSudo(server, `docker restart ${cn}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart MTProxy container: ${restartRes.stderr}`);
  }

  const link = buildMtprotoLink(server.host, c.port, secret, c.tlsDomain || '');
  return { config: link, type: 'mtproxy' };
}
