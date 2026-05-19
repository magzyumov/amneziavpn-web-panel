import { NodeSSH } from 'node-ssh';
import { decrypt } from './crypto.js';

const connections = new Map();

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

function shouldReconnect(err) {
  const msg = err?.message || String(err);
  return RECONNECT_PATTERNS.some(re => re.test(msg));
}

export async function getConnection(server) {
  const key = server.id;
  if (connections.has(key)) return connections.get(key);

  const ssh = new NodeSSH();
  const config = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: 15000,
    // Пингуем канал каждые 30s; если 3 пинга подряд не получили ответа — рвём.
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  };

  if (server.auth_type === 'key' && server.private_key) {
    config.privateKey = decrypt(server.private_key);
  } else {
    config.password = decrypt(server.password);
  }

  await ssh.connect(config);
  connections.set(key, ssh);
  return ssh;
}

async function execOnce(server, command) {
  const ssh = await getConnection(server);
  const result = await ssh.execCommand(command);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code,
  };
}

export async function exec(server, command) {
  try {
    return await execOnce(server, command);
  } catch (e) {
    if (!shouldReconnect(e)) throw e;
    // Stale connection — drop and retry once.
    disconnect(server.id);
    return await execOnce(server, command);
  }
}

export async function execSudo(server, command) {
  return exec(server, `sudo bash -c '${command.replace(/'/g, "'\\''")}'`);
}

export function disconnect(serverId) {
  if (connections.has(serverId)) {
    try { connections.get(serverId).dispose(); } catch {}
    connections.delete(serverId);
  }
}

export function disconnectAll() {
  for (const id of [...connections.keys()]) disconnect(id);
}

export async function testConnection(server) {
  try {
    const ssh = await getConnection(server);
    const result = await ssh.execCommand('uname -a && docker --version 2>/dev/null || echo "docker-not-found"');
    return {
      ok: true,
      info: result.stdout,
      dockerAvailable: !result.stdout.includes('docker-not-found'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
