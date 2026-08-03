// Общая механика WireGuard-подобных протоколов (WireGuard и AmneziaWG).
//
// Установка и выпуск клиента у них совпадали почти дословно: те же аргументы
// docker run, тот же порядок «собрать образ → запустить → сконфигурировать →
// перезапустить», та же выдача ключей и дописывание [Peer] в конфиг. Отличались
// только имя CLI (wg/awg), имя интерфейса и пути.
//
// Дублирование было не безобидным: правку per-protocol start.sh (f74fa36)
// применили к awg2 и xray, а WireGuard забыли — и он молча остался с чужим
// ENTRYPOINT, из-за чего wg0 не поднимался, а добавление клиента падало с
// "Unable to modify interface: No such device".

import { exec, execSudo } from '../ssh.js';
import { sh } from '../shell.js';
import {
  writeRemoteFile, readRemoteFile, buildImage, assertPortFree, removePeerBlock,
} from './common.js';
import { UserError } from '../errors.js';
import type { Server } from '../../types.js';

export interface WgFlavor {
  /** Имя CLI внутри контейнера. */
  tool: 'awg' | 'wg';
  /** Имя сетевого интерфейса (awg0 / wg0). */
  iface: string;
  /** Каталог с конфигами и ключами внутри /opt/amnezia. */
  confDir: string;
  containerName: string;
  imageName: string;
  buildDir: string;
  /** Как протокол называется в текстах ошибок. */
  label: string;
}

export const confPath = (f: WgFlavor): string => `${f.confDir}/${f.iface}.conf`;

interface InstallArgs {
  port: number;
  subnetIp: string;
  subnetCidr: string;
  dockerfile: string;
  startScript: string;
  /**
   * Содержимое configure-скрипта целиком, вместе с export-ами. Может быть
   * функцией: AmneziaWG генерирует HeaderProtectionKey через `awg genkey`
   * ВНУТРИ контейнера, то есть уже после его запуска.
   */
  configureScript: string | (() => Promise<string>);
  /** Куда положить configure-скрипт (у протоколов разные имена файлов). */
  configurePath: string;
  /** Файл с публичным ключом сервера, который создаёт configure-скрипт. */
  serverPubKeyPath: string;
}

// Полный цикл установки. Возвращает публичный ключ сервера.
export async function installWgLike(server: Server, f: WgFlavor, args: InstallArgs): Promise<string> {
  // Освобождаем порт от своего старого контейнера (переустановка), затем проверяем,
  // что порт не занят кем-то ещё на хосте.
  await execSudo(server, `docker rm -f ${f.containerName} 2>/dev/null || true`);
  await assertPortFree(server, args.port, f.containerName);

  await buildImage(server, f.imageName, f.buildDir, args.dockerfile);

  await execSudo(server, `mkdir -p ${f.confDir}`);
  await writeRemoteFile(server, `${f.confDir}/start.sh`, args.startScript);
  await execSudo(server, `chmod +x ${f.confDir}/start.sh`);

  await execSudo(server, [
    `docker run -d`,
    `--log-driver none`,
    `--restart always`,
    `--privileged`,
    `--cap-add=NET_ADMIN`,
    `--cap-add=SYS_MODULE`,
    `-p ${args.port}:${args.port}/udp`,
    `-v /lib/modules:/lib/modules`,
    `-v /opt/amnezia:/opt/amnezia`,
    `--sysctl="net.ipv4.conf.all.src_valid_mark=1"`,
    `--name ${f.containerName}`,
    f.imageName,
  ].join(' \\\n  '));
  await execSudo(server, `docker network connect amnezia-dns-net ${f.containerName}`);

  const configureScript = typeof args.configureScript === 'string'
    ? args.configureScript
    : await args.configureScript();
  await writeRemoteFile(server, args.configurePath, configureScript);
  const configureRes = await execSudo(server, `docker exec ${f.containerName} bash ${args.configurePath}`);
  if (configureRes.code !== 0) {
    throw new UserError(`${f.label} configure script failed (exit ${configureRes.code}): ${configureRes.stderr || configureRes.stdout}`);
  }

  // start.sh поднимает интерфейс, только если конфиг существует на момент старта
  // контейнера. При установке конфиг создаётся configure-скриптом ПОСЛЕ старта,
  // поэтому интерфейс остаётся не поднятым (set падает с "No such device").
  // Перезапускаем — теперь start.sh найдёт конфиг и поднимет интерфейс.
  const restartRes = await execSudo(server, `docker restart ${f.containerName}`);
  if (restartRes.code !== 0) {
    throw new UserError(`Failed to restart ${f.label} container after configure: ${restartRes.stderr || restartRes.stdout}`);
  }

  const serverPubKey = await readRemoteFile(server, args.serverPubKeyPath);
  if (!serverPubKey) throw new UserError(`${f.label} configure script did not generate server public key`);
  return serverPubKey;
}

// Контейнер должен быть запущен — иначе любой set по интерфейсу бессмыслен.
export async function assertContainerRunning(server: Server, f: WgFlavor): Promise<void> {
  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${f.containerName} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new UserError(`${f.label} container '${f.containerName}' is not running. Start the protocol first.`);
  }
}

export interface PeerKeys { clientPrivKey: string; clientPubKey: string }

export async function genPeerKeys(server: Server, f: WgFlavor): Promise<PeerKeys> {
  const privRes = await execSudo(server, `docker exec ${f.containerName} ${f.tool} genkey`);
  if (privRes.code !== 0 || !privRes.stdout.trim()) {
    throw new UserError(`Failed to generate ${f.label} client private key: ${privRes.stderr || 'empty output'}`);
  }
  const clientPrivKey = privRes.stdout.trim();

  const pubRes = await execSudo(server, `echo '${clientPrivKey}' | docker exec -i ${f.containerName} ${f.tool} pubkey`);
  if (pubRes.code !== 0 || !pubRes.stdout.trim()) {
    throw new UserError(`Failed to generate ${f.label} client public key: ${pubRes.stderr || 'empty output'}`);
  }
  return { clientPrivKey, clientPubKey: pubRes.stdout.trim() };
}

// Следующий свободный адрес в подсети: считаем существующих пиров и берём +2
// (первый адрес занимает сам сервер).
export async function nextClientIp(server: Server, f: WgFlavor, subnetPrefix: string): Promise<string> {
  const peersRes = await execSudo(server, `docker exec ${f.containerName} ${f.tool} show ${f.iface} peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  return `${subnetPrefix}.${peerCount + 2}`;
}

// Добавляет пира в живой интерфейс и дописывает [Peer] в конфиг на диске.
// PSK передаётся во временный файл: в аргументах команды он остался бы в ps.
export async function addPeer(
  server: Server, f: WgFlavor,
  peer: { clientPubKey: string; presharedKey: string; clientIp: string },
): Promise<void> {
  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(peer.presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${f.containerName} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);

  const addPeerRes = await execSudo(server,
    `docker exec ${f.containerName} sh -c "${f.tool} set ${f.iface} peer ${peer.clientPubKey} preshared-key ${pskTmp} allowed-ips ${peer.clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new UserError(`Failed to add ${f.label} peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  const peerEntry = Buffer.from(
    `\n[Peer]\nPublicKey = ${peer.clientPubKey}\nPresharedKey = ${peer.presharedKey}\nAllowedIPs = ${peer.clientIp}/32\n`,
  ).toString('base64');
  await execSudo(server, `echo '${peerEntry}' | base64 -d | docker exec -i ${f.containerName} tee -a ${confPath(f)} > /dev/null`);
}

// Отзыв клиента: убираем пира из живого интерфейса и из конфига (peerId = pubkey).
export async function removePeer(server: Server, f: WgFlavor, peerId: string): Promise<void> {
  await execSudo(server, `docker exec ${f.containerName} ${f.tool} set ${f.iface} peer ${sh(peerId)} remove 2>/dev/null || true`);
  const conf = await readRemoteFile(server, confPath(f));
  if (conf) {
    await writeRemoteFile(server, confPath(f), removePeerBlock(conf, peerId));
  }
}
