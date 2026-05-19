import { NodeSSH } from 'node-ssh';
import { decrypt } from './crypto.js';
import type { Server, ExecResult } from '../types.js';

const connections = new Map<string, NodeSSH>();

// Сообщения, по которым считаем что SSH-канал умер и нужно переподключиться.
const RECONNECT_PATTERNS = [
  /not connected/i,
  /connection lost/i,
  /channel closed/i,
  /no response/i,
  /ECONNRESET/,
  /EPIPE/,
  /Client network socket/i,
];

function shouldReconnect(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RECONNECT_PATTERNS.some(re => re.test(msg));
}

export async function getConnection(server: Server): Promise<NodeSSH> {
  const key = server.id;
  const cached = connections.get(key);
  if (cached) return cached;

  const ssh = new NodeSSH();
  const config: Parameters<NodeSSH['connect']>[0] = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: 15000,
    // Пингуем канал каждые 30s; если 3 пинга подряд не получили ответа — рвём.
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  };

  if (server.auth_type === 'key' && server.private_key) {
    config.privateKey = decrypt(server.private_key) as string;
  } else {
    config.password = decrypt(server.password) as string;
  }

  await ssh.connect(config);
  connections.set(key, ssh);
  return ssh;
}

async function execOnce(server: Server, command: string): Promise<ExecResult> {
  const ssh = await getConnection(server);
  const result = await ssh.execCommand(command);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code,
  };
}

export async function exec(server: Server, command: string): Promise<ExecResult> {
  try {
    return await execOnce(server, command);
  } catch (e) {
    if (!shouldReconnect(e)) throw e;
    disconnect(server.id);
    return await execOnce(server, command);
  }
}

export async function execSudo(server: Server, command: string): Promise<ExecResult> {
  return exec(server, `sudo bash -c '${command.replace(/'/g, "'\\''")}'`);
}

export function disconnect(serverId: string): void {
  const conn = connections.get(serverId);
  if (conn) {
    try { conn.dispose(); } catch { /* ignore */ }
    connections.delete(serverId);
  }
}

export function disconnectAll(): void {
  for (const id of [...connections.keys()]) disconnect(id);
}

export interface TestConnectionResult {
  ok: boolean;
  info?: string;
  dockerAvailable?: boolean;
  error?: string;
}

export async function testConnection(server: Server): Promise<TestConnectionResult> {
  try {
    const ssh = await getConnection(server);
    const result = await ssh.execCommand('uname -a && docker --version 2>/dev/null || echo "docker-not-found"');
    return {
      ok: true,
      info: result.stdout,
      dockerAvailable: !result.stdout.includes('docker-not-found'),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
