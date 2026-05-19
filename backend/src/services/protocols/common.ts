import { exec, execSudo } from '../ssh.js';
import type { Server } from '../../types.js';

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randRange(min: number, max: number): string {
  const a = randInt(min, max), b = randInt(min, max);
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

export function randPort(): number {
  return randInt(10000, 62000);
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

export async function buildImage(server: Server, imageName: string, buildDir: string, dockerfile: string): Promise<void> {
  if (await imageExists(server, imageName)) return;
  await execSudo(server, `mkdir -p ${buildDir}`);
  await writeRemoteFile(server, `${buildDir}/Dockerfile`, dockerfile);
  const res = await execSudo(server, `docker build -t ${imageName} ${buildDir} 2>&1`);
  if (res.code !== 0) {
    throw new Error(`docker build failed:\n${res.stdout.slice(-2000)}`);
  }
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((str, [k, v]) =>
    str.replaceAll(`$${k}`, String(v)), template);
}
