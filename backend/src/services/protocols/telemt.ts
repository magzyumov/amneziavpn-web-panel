import { randomBytes } from 'node:crypto';
import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertPort, assertDomain } from '../shell.js';
import { randPort, writeRemoteFile, buildImage, renderTemplate } from './common.js';
import { DOCKERFILES, START_SCRIPTS, TELEMT_BASE_CONFIG_TEMPLATE } from './dockerfiles.js';
import { buildMtprotoLink } from './mtproxy.js';
import type { Server, Protocol, AddClientResult, InstallResult, TelemtConfig } from '../../types.js';

interface TelemtInstallOptions { port?: number; tlsDomain?: string }

export async function installTelemt(server: Server, options: TelemtInstallOptions = {}): Promise<InstallResult> {
  const port = assertPort(options.port || randPort());
  // Telemt всегда работает в FakeTLS-режиме — домен обязателен.
  const tlsDomain = assertDomain(options.tlsDomain || 'www.google.com');
  const containerName = 'amnezia-telemt';
  const imageName = 'amnezia-telemt:latest';
  const buildDir = '/opt/amnezia/amnezia-telemt';

  await buildImage(server, imageName, buildDir, DOCKERFILES.telemt);

  await execSudo(server, `mkdir -p /opt/amnezia/telemt/tlsfront`);

  const baseConfig = renderTemplate(TELEMT_BASE_CONFIG_TEMPLATE, {
    TELEMT_HOST: server.host,
    TELEMT_PORT: port,
    TELEMT_TLS_DOMAIN: tlsDomain,
  });
  await writeRemoteFile(server, `/opt/amnezia/telemt/config.base.toml`, baseConfig);
  await writeRemoteFile(server, `/opt/amnezia/telemt/start.sh`, START_SCRIPTS.telemt());
  await execSudo(server, `chmod +x /opt/amnezia/telemt/start.sh`);
  await execSudo(server, `touch /opt/amnezia/telemt/users`);

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

  const config: TelemtConfig = { port, tlsDomain };
  return { containerName, port, config };
}

export async function addTelemtClient(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.port) {
    throw new Error('Telemt protocol config is incomplete (missing port). Reinstall the protocol.');
  }

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`Telemt container '${cn}' is not running. Start the protocol first.`);
  }

  const secret = randomBytes(16).toString('hex');
  // Ключ пользователя в [access.users] — только метка для telemt; берём от
  // секрета, чтобы был ascii-safe и уникальный (имя клиента хранится в БД).
  const userKey = `c_${secret.slice(0, 12)}`;

  // Дописываем строку пользователя в файл users (host-mounted) и рестартим —
  // start.sh пересоберёт config.toml из base + users.
  await execSudo(server, `printf '%s = "%s"\\n' '${userKey}' '${secret}' >> /opt/amnezia/telemt/users`);
  const restartRes = await execSudo(server, `docker restart ${cn}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart Telemt container: ${restartRes.stderr}`);
  }

  // Telemt всегда FakeTLS — ee-secret с доменом.
  const link = buildMtprotoLink(server.host, c.port, secret, c.tlsDomain || 'www.google.com');
  return { config: link, type: 'telemt' };
}
