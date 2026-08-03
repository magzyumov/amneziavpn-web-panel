import { createHash } from 'crypto';
import { exec, execSudo } from '../ssh.js';
import type { Server } from '../../types.js';

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randPort(): number {
  return randInt(10000, 62000);
}

// Подготовка хоста перед установкой протокола (идемпотентно).
// Включает IP-форвардинг и создаёт сеть amnezia-dns-net один раз.
export async function prepareHost(server: Server): Promise<void> {
  // Docker обычно включает форвардинг сам, но делаем явно. best-effort.
  await execSudo(server, 'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true');
  // Параметры сети — как в оригинальном prepare_host.sh (фиксированная подсеть,
  // чтобы будущий AmneziaDNS-контейнер мог получить статичный IP). Создаём один раз.
  const exists = await exec(server, `docker network ls --format '{{.Name}}' | grep -qx amnezia-dns-net && echo yes || echo no`);
  if (exists.stdout.trim() !== 'yes') {
    await execSudo(server, 'docker network create --driver bridge --subnet=172.29.172.0/24 --opt com.docker.network.bridge.name=amn0 amnezia-dns-net 2>/dev/null || true');
  }
}

// Проверяет, что TCP/UDP-порт свободен на хосте. Свой контейнер (selfName)
// игнорируем — это переустановка. Бросает с понятным сообщением при конфликте.
export async function assertPortFree(server: Server, port: number, selfName: string): Promise<void> {
  // Контейнеры, публикующие этот порт (кроме нашего собственного).
  const dockerRes = await execSudo(server, `docker ps --format '{{.Names}}' --filter publish=${port}`);
  const others = dockerRes.stdout.split('\n').map(s => s.trim()).filter(n => n && n !== selfName);
  if (others.length) {
    throw new Error(`Порт ${port} уже занят контейнером: ${others.join(', ')}. Выберите другой порт или удалите конфликтующий контейнер.`);
  }
  // Не-docker сервисы на хосте. ss может отсутствовать — тогда проверку пропускаем.
  const ssRes = await exec(server, `ss -Hltnu 'sport = :${port}' 2>/dev/null || true`);
  if (ssRes.stdout.trim()) {
    throw new Error(`Порт ${port} уже слушается процессом на хосте. Выберите другой порт.`);
  }
}

// Запись файла через base64 — без проблем с экранированием.
export async function writeRemoteFile(server: Server, remotePath: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const tmp = `/tmp/.amnezia_${Date.now()}`;
  const chunkSize = 4000;
  await execSudo(server, `printf '' > ${tmp}.b64`);
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    await execSudo(server, `printf '%s' '${chunk}' >> ${tmp}.b64`);
  }
  await execSudo(server, `base64 -d ${tmp}.b64 > ${remotePath} && rm -f ${tmp}.b64`);
}

export async function readRemoteFile(server: Server, remotePath: string): Promise<string> {
  const res = await execSudo(server, `cat ${remotePath} 2>/dev/null`);
  return res.stdout.trim();
}

export async function readContainerFile(server: Server, containerName: string, remotePath: string): Promise<string> {
  const res = await execSudo(server, `docker exec ${containerName} cat ${remotePath} 2>/dev/null`);
  return res.stdout.trim();
}

export async function imageExists(server: Server, imageName: string): Promise<boolean> {
  const res = await exec(server, `docker image inspect ${imageName} --format='exists' 2>/dev/null || echo ""`);
  return res.stdout.trim() === 'exists';
}

// Метка с отпечатком Dockerfile, по которой buildImage понимает, что образ на
// сервере собран из УСТАРЕВШЕГО шаблона.
const DOCKERFILE_LABEL = 'panel.dockerfile-sha';

export async function buildImage(server: Server, imageName: string, buildDir: string, dockerfile: string): Promise<void> {
  // Раньше проверка была «образ с таким именем есть → ничего не делаем», и правки
  // шаблонов не доезжали до серверов, где образ уже собран. Так у amnezia-wireguard
  // на месяцы залип ENTRYPOINT на общий /opt/amnezia/start.sh (до перехода на
  // per-protocol start.sh): контейнер стартовал чужой скрипт, wg0 не поднимался,
  // и добавление клиента падало с "Unable to modify interface: No such device".
  // Теперь образ переиспользуется, только если собран ровно из этого Dockerfile.
  const sha = createHash('sha256').update(dockerfile).digest('hex').slice(0, 16);
  const labelRes = await exec(server,
    `docker image inspect ${imageName} --format='{{index .Config.Labels "${DOCKERFILE_LABEL}"}}' 2>/dev/null || echo ""`);
  if (labelRes.stdout.trim() === sha) return;

  await execSudo(server, `mkdir -p ${buildDir}`);
  await writeRemoteFile(server, `${buildDir}/Dockerfile`, dockerfile);
  const res = await execSudo(server,
    `docker build --label ${DOCKERFILE_LABEL}=${sha} -t ${imageName} ${buildDir} 2>&1`);
  if (res.code !== 0) {
    throw new Error(`docker build failed:\n${res.stdout.slice(-2000)}`);
  }
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((str, [k, v]) =>
    str.replaceAll(`$${k}`, String(v)), template);
}

// Удаляет [Peer]-блок с указанным PublicKey из WG/AWG .conf.
// [Interface] и остальные пиры сохраняются. Возвращает обновлённый текст.
export function removePeerBlock(conf: string, pubKey: string): string {
  const lines = conf.split('\n');
  const out: string[] = [];
  let block: string[] = [];
  let inPeer = false;
  const flush = () => {
    if (block.length) {
      const match = block.some(l => /^\s*publickey\s*=/i.test(l) && l.includes(pubKey));
      if (!match) out.push(...block);
    }
    block = [];
  };
  for (const line of lines) {
    if (line.trim().toLowerCase() === '[peer]') {
      flush();
      inPeer = true;
      block.push(line);
    } else if (inPeer) {
      block.push(line);
    } else {
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}
