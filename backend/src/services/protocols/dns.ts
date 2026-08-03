import { exec, execSudo } from '../ssh.js';
import { buildImage, runContainer } from './common.js';
import { DOCKERFILES } from './dockerfiles.js';
import type { Server } from '../../types.js';
import { UserError } from '../errors.js';

// AmneziaDNS — серверный unbound-резолвер на фиксированном IP в amnezia-dns-net.
// На него указывают DNS-настройки клиентов (защита от DNS-leak: наружу DoT к Cloudflare).
export const AMNEZIA_DNS_IP = '172.29.172.254';
const DNS_SUBNET   = '172.29.172.0/24';
const NET          = 'amnezia-dns-net';
const CONTAINER    = 'amnezia-dns';
const IMAGE        = 'amnezia-dns:latest';
const BUILD_DIR    = '/opt/amnezia/amnezia-dns';

// Гарантирует, что amnezia-dns-net имеет нужную подсеть (для фикс. IP DNS).
// На старых серверах сеть могла быть создана плейн-bridge без подсети —
// тогда пересоздаём, переподключая уже подключённые контейнеры.
async function ensureDnsNetwork(server: Server): Promise<void> {
  const sub = await exec(server, `docker network inspect ${NET} -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || echo ''`);
  const current = sub.stdout.trim();
  if (current.split(/\s+/).includes(DNS_SUBNET)) return; // уже правильная подсеть

  const createCmd = `docker network create --driver bridge --subnet=${DNS_SUBNET} --opt com.docker.network.bridge.name=amn0 ${NET}`;

  if (current === '') {
    // Сети нет вовсе — просто создаём.
    await execSudo(server, `${createCmd} 2>/dev/null || true`);
    return;
  }

  // Сеть есть, но с другой подсетью — пересоздаём с переподключением контейнеров.
  const cont = await exec(server, `docker network inspect ${NET} -f '{{range $k,$v := .Containers}}{{$k}} {{end}}' 2>/dev/null || echo ''`);
  const ids = cont.stdout.trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    await execSudo(server, `docker network disconnect -f ${NET} ${id} 2>/dev/null || true`);
  }
  await execSudo(server, `docker network rm ${NET} 2>/dev/null || true`);
  await execSudo(server, createCmd);
  for (const id of ids) {
    await execSudo(server, `docker network connect ${NET} ${id} 2>/dev/null || true`);
  }
}

export async function isDnsRunning(server: Server): Promise<boolean> {
  const res = await exec(server, `docker inspect --format='{{.State.Status}}' ${CONTAINER} 2>/dev/null || echo ''`);
  return res.stdout.trim() === 'running';
}

// DNS-строка для клиентских конфигов: AmneziaDNS если установлен, иначе публичные.
export async function resolveClientDns(server: Server): Promise<string> {
  return (await isDnsRunning(server)) ? AMNEZIA_DNS_IP : '1.1.1.1, 8.8.8.8';
}

export function dnsRunArgs(): string[] {
  return [
    `--log-driver none`,
    `--restart always`,
    `--network ${NET}`,
    `--ip=${AMNEZIA_DNS_IP}`,
    `--name ${CONTAINER}`,
    IMAGE,
  ];
}

export async function installDns(server: Server): Promise<{ containerName: string; ip: string }> {
  await ensureDnsNetwork(server);
  await buildImage(server, IMAGE, BUILD_DIR, DOCKERFILES.dns);
  await execSudo(server, `docker rm -f ${CONTAINER} 2>/dev/null || true`);
  const runRes = await runContainer(server, dnsRunArgs());
  if (runRes.code !== 0) {
    throw new UserError(`Failed to start AmneziaDNS container: ${runRes.stderr || runRes.stdout}`);
  }
  return { containerName: CONTAINER, ip: AMNEZIA_DNS_IP };
}

export async function removeDns(server: Server): Promise<void> {
  await execSudo(server, `docker rm -f ${CONTAINER} 2>/dev/null || true`);
}
