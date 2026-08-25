// Обнаружение расхождения между тем, что описано в коде, и тем, что реально
// крутится на сервере.
//
// buildImage пересобирает образ, если изменился Dockerfile, но только в момент
// установки. До этого момента на сервере может годами жить контейнер, собранный
// из устаревшего шаблона или запущенный со старыми флагами docker run — и никак
// себя не проявлять. Ровно так у amnezia-wireguard месяцами оставался чужой
// ENTRYPOINT: панель считала протокол установленным и работающим, а wg0 не
// поднимался.
//
// Здесь мы сравниваем метки на образе и контейнере с тем, что панель поставила
// бы сейчас, и показываем расхождение в UI. Само по себе оно не ошибка —
// лечится upgradeProtocolContainer (в конце файла), а если новая версия требует
// новых параметров в самом конфиге — переустановкой протокола.

import { createHash } from 'crypto';
import { exec, execSudo } from '../ssh.js';
import { UserError } from '../errors.js';
import { assertContainerName } from '../shell.js';
import {
  RUN_ARGS_LABEL, runArgsSha, buildImage, runContainer, writeRemoteFile, driftFromLabels,
  type ProtocolDrift,
} from './common.js';
import { DOCKERFILES, START_SCRIPTS } from './dockerfiles.js';
import { wgRunArgs } from './wgCommon.js';
// Флейворы берём из самих протоколов, а не держим копию: тег образа менялся бы
// в двух местах, и детектор дрейфа начал бы сравнивать с несуществующим образом.
import { AWG2_FLAVOR } from './awg2.js';
import { WG_FLAVOR } from './wireguard.js';
import { xrayRunArgs, XRAY_IMAGE } from './xray.js';
import { telemtRunArgs, TELEMT_IMAGE } from './telemt.js';
import type { Server, Protocol, ProtocolType } from '../../types.js';

const DOCKERFILE_LABEL = 'panel.dockerfile-sha';

interface ContainerPlan {
  image: string;
  dockerfile: string;
  buildDir: string;
  runArgs: string[];
  /** Куда лечь start.sh. Каталог общий с конфигами протокола. */
  confDir: string;
  /** start.sh зависит от конфига протокола, поэтому считается лениво. */
  startScript: (serverHost: string, config: Record<string, unknown>) => string;
  /** Нужно ли подключать контейнер к amnezia-dns-net после запуска. */
  dnsNet: boolean;
}

// Что панель поставила бы сейчас для протокола данного типа.
function expected(type: ProtocolType, port: number): ContainerPlan | null {
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
  switch (type) {
    case 'awg2': return {
      image: AWG2_FLAVOR.imageName, dockerfile: DOCKERFILES.awg2, buildDir: AWG2_FLAVOR.buildDir,
      runArgs: wgRunArgs(AWG2_FLAVOR, port), confDir: AWG2_FLAVOR.confDir, dnsNet: true,
      startScript: (host, c) => START_SCRIPTS.awg2(str(c.subnetIp, '10.8.1.0'), str(c.subnetCidr, '24'), host),
    };
    case 'wireguard': return {
      image: WG_FLAVOR.imageName, dockerfile: DOCKERFILES.wireguard, buildDir: WG_FLAVOR.buildDir,
      runArgs: wgRunArgs(WG_FLAVOR, port), confDir: WG_FLAVOR.confDir, dnsNet: true,
      startScript: (host, c) => START_SCRIPTS.wireguard(str(c.subnetIp, '10.8.1.0'), str(c.subnetCidr, '24'), host),
    };
    case 'xray': return {
      image: XRAY_IMAGE, dockerfile: DOCKERFILES.xray, buildDir: '/opt/amnezia/amnezia-xray',
      runArgs: xrayRunArgs(port), confDir: '/opt/amnezia/xray', dnsNet: true,
      startScript: host => START_SCRIPTS.xray(port, host),
    };
    case 'telemt': return {
      image: TELEMT_IMAGE, dockerfile: DOCKERFILES.telemt, buildDir: '/opt/amnezia/amnezia-telemt',
      runArgs: telemtRunArgs(port), confDir: '/opt/amnezia/telemt', dnsNet: false,
      startScript: () => START_SCRIPTS.telemt(),
    };
    default: return null;
  }
}

export type { ProtocolDrift } from './common.js';

export interface DriftTarget {
  id: string;
  type: ProtocolType;
  containerName: string;
  port: number | null;
}

// Метки читаем одним SSH-вызовом на все контейнеры сразу — проверка дёргается
// из периодического health-запроса, лишние заходы там дорогие.
export async function getProtocolsDrift(
  server: Server, targets: readonly DriftTarget[],
): Promise<Record<string, ProtocolDrift>> {
  const checkable = targets.filter(t => t.port != null && expected(t.type, t.port) !== null);
  if (!checkable.length) return {};

  const cmds = checkable.map(t => {
    const e = expected(t.type, t.port as number)!;
    return `echo "${t.id}|$(docker inspect --format='{{index .Config.Labels "${RUN_ARGS_LABEL}"}}' ${t.containerName} 2>/dev/null)|$(docker image inspect --format='{{index .Config.Labels "${DOCKERFILE_LABEL}"}}' ${e.image} 2>/dev/null)"`;
  });
  const res = await exec(server, cmds.join('; '));

  const out: Record<string, ProtocolDrift> = {};
  for (const line of res.stdout.trim().split('\n')) {
    const [id, actualRun, actualImage] = line.split('|');
    const target = checkable.find(t => t.id === id);
    if (!target) continue;
    const e = expected(target.type, target.port as number)!;
    out[id] = driftFromLabels(actualRun || '', actualImage || '', e.dockerfile, e.runArgs);
  }
  return out;
}

// Пересоздаёт контейнер протокола на актуальном образе, НЕ трогая его конфиги.
//
// Единственным способом доехать до нового образа была переустановка протокола
// (DELETE + POST), а она перегенерирует ключи: у Xray — Reality-пару и UUID,
// у AWG — серверный приватный ключ. Вместе с ними умирают все выданные конфиги
// и подписки. При этом всё состояние протокола лежит на ХОСТЕ
// (`-v /opt/amnezia:/opt/amnezia` есть у всех четырёх типов), поэтому пересоздать
// контейнер на новом образе можно, ничего не потеряв.
//
// Что обновляется: образ (если Dockerfile уехал), start.sh и аргументы docker run.
// Что НЕ обновляется: содержимое конфигов протокола — параметры обфускации,
// server.json, список пиров. Если бампнутая версия требует новых параметров
// в самом конфиге (как RandomTrailers у AWG 3.1), нужна переустановка.
export async function upgradeProtocolContainer(server: Server, protocol: Protocol): Promise<void> {
  if (protocol.port == null) {
    throw new UserError('Cannot upgrade a protocol without a known port. Reinstall it instead.');
  }
  const plan = expected(protocol.type, protocol.port);
  if (!plan) throw new UserError(`Upgrade is not supported for protocol type ${protocol.type}`);
  assertContainerName(protocol.container_name);

  const config: Record<string, unknown> = typeof protocol.config === 'string'
    ? JSON.parse(protocol.config)
    : (protocol.config ?? {});

  await buildImage(server, plan.image, plan.buildDir, plan.dockerfile);

  await execSudo(server, `mkdir -p ${plan.confDir}`);
  await writeRemoteFile(server, `${plan.confDir}/start.sh`, plan.startScript(server.host, config));
  await execSudo(server, `chmod +x ${plan.confDir}/start.sh`);

  await execSudo(server, `docker rm -f ${protocol.container_name} 2>/dev/null || true`);
  const runRes = await runContainer(server, plan.runArgs);
  if (runRes.code !== 0) {
    throw new UserError(`Failed to start ${protocol.type} container: ${runRes.stderr || runRes.stdout}`);
  }
  if (plan.dnsNet) {
    await execSudo(server, `docker network connect amnezia-dns-net ${protocol.container_name}`);
  }
  if (protocol.type === 'xray') {
    await execSudo(server, `docker exec -i ${protocol.container_name} bash -c 'mkdir -p /dev/net; if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200; fi'`);
  }

  // Конфиг уже лежит на хосте на момент старта, так что start.sh поднимает
  // протокол сам — перезапуск нужен только затем, чтобы демон подхватил
  // /dev/net/tun и dns-net, появившиеся после запуска.
  const restartRes = await execSudo(server, `docker restart ${protocol.container_name}`);
  if (restartRes.code !== 0) {
    throw new UserError(`Failed to restart ${protocol.type} container: ${restartRes.stderr || restartRes.stdout}`);
  }
}
