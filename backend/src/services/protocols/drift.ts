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
// лечится переустановкой протокола.

import { createHash } from 'crypto';
import { exec } from '../ssh.js';
import { RUN_ARGS_LABEL, runArgsSha } from './common.js';
import { DOCKERFILES } from './dockerfiles.js';
import { wgRunArgs } from './wgCommon.js';
// Флейворы берём из самих протоколов, а не держим копию: тег образа менялся бы
// в двух местах, и детектор дрейфа начал бы сравнивать с несуществующим образом.
import { AWG2_FLAVOR } from './awg2.js';
import { WG_FLAVOR } from './wireguard.js';
import { xrayRunArgs, XRAY_IMAGE } from './xray.js';
import { telemtRunArgs, TELEMT_IMAGE } from './telemt.js';
import type { Server, ProtocolType } from '../../types.js';

const DOCKERFILE_LABEL = 'panel.dockerfile-sha';

// Что панель поставила бы сейчас для протокола данного типа.
function expected(type: ProtocolType, port: number): { image: string; dockerfile: string; runArgs: string[] } | null {
  switch (type) {
    case 'awg2':      return { image: AWG2_FLAVOR.imageName, dockerfile: DOCKERFILES.awg2,      runArgs: wgRunArgs(AWG2_FLAVOR, port) };
    case 'wireguard': return { image: WG_FLAVOR.imageName,   dockerfile: DOCKERFILES.wireguard, runArgs: wgRunArgs(WG_FLAVOR, port) };
    case 'xray':      return { image: XRAY_IMAGE,            dockerfile: DOCKERFILES.xray,      runArgs: xrayRunArgs(port) };
    case 'telemt':    return { image: TELEMT_IMAGE,          dockerfile: DOCKERFILES.telemt,    runArgs: telemtRunArgs(port) };
    default:          return null;
  }
}

export interface ProtocolDrift {
  /** Образ собран из другого Dockerfile, чем описан в коде сейчас. */
  image: boolean;
  /** Контейнер запущен с другими аргументами docker run. */
  runArgs: boolean;
}

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
    const wantImage = createHash('sha256').update(e.dockerfile).digest('hex').slice(0, 16);

    // Пустая метка = контейнер или образ созданы до появления меток. Это не
    // доказательство расхождения, поэтому такие случаи не помечаем — иначе
    // «устарел» горел бы у всех, кто не переустанавливался.
    out[id] = {
      image:   Boolean(actualImage) && actualImage.trim() !== wantImage,
      runArgs: Boolean(actualRun)   && actualRun.trim()   !== runArgsSha(e.runArgs),
    };
  }
  return out;
}
