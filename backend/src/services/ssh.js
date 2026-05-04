import { NodeSSH } from 'node-ssh';

const connections = new Map();

export async function getConnection(server) {
  const key = server.id;
  if (connections.has(key)) {
    const conn = connections.get(key);
    try {
      await conn.execCommand('echo ok');
      return conn;
    } catch {
      connections.delete(key);
    }
  }

  const ssh = new NodeSSH();
  const config = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: 15000,
  };

  if (server.auth_type === 'key' && server.private_key) {
    config.privateKey = server.private_key;
  } else {
    config.password = server.password;
  }

  await ssh.connect(config);
  connections.set(key, ssh);
  return ssh;
}

export async function exec(server, command) {
  const ssh = await getConnection(server);
  const result = await ssh.execCommand(command);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code,
  };
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
