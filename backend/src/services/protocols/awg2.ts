import { exec, execSudo } from '../ssh.js';
import { assertContainerName, assertPort, shInt } from '../shell.js';
import {
  randInt, randRange, randPort,
  writeRemoteFile, readRemoteFile, buildImage, renderTemplate,
} from './common.js';
import {
  DOCKERFILES, START_SCRIPTS, CONFIGURE_SCRIPTS,
  AWG2_CLIENT_TEMPLATE, AWG2_CLIENT_JSON_TEMPLATE,
} from './dockerfiles.js';
import type {
  Server, Protocol, AddClientResult, InstallResult, Awg2Config,
} from '../../types.js';

interface InstallOptions {
  port?: number;
  jc?: number; jmin?: number; jmax?: number;
  s1?: number; s2?: number; s3?: number; s4?: number;
  h1?: number; h2?: number; h3?: number; h4?: number;
  i1?: number; i2?: number; i3?: number; i4?: number; i5?: number;
}

export async function installAWG2(server: Server, options: InstallOptions = {}): Promise<InstallResult> {
  const port      = assertPort(options.port || randPort());
  const subnetIp  = '10.8.1.0';
  const subnetCidr = '24';
  const containerName = 'amnezia-awg2';
  const imageName = 'amnezia-awg2:latest';
  const buildDir  = '/opt/amnezia/amnezia-awg2';

  // Параметры обфускации AWG2 — все integer, валидируем чтобы не пустить shell-injection в configure-script.
  const intOpt = (v: number | undefined, fallback: number | string, label: string): number | string =>
    v == null ? fallback : shInt(v, { min: 0, max: 4294967295, label });
  const jc   = intOpt(options.jc,   randInt(3, 10),                'jc');
  const jmin = intOpt(options.jmin, randInt(10, 50),               'jmin');
  const jmax = intOpt(options.jmax, randInt(200, 1000),            'jmax');
  const s1   = intOpt(options.s1,   randInt(100, 200),             's1');
  const s2   = intOpt(options.s2,   randInt(100, 200),             's2');
  const s3   = intOpt(options.s3,   randInt(30, 100),              's3');
  const s4   = intOpt(options.s4,   randInt(10, 50),               's4');
  const h1   = intOpt(options.h1,   randRange(600000000, 1500000000),  'h1');
  const h2   = intOpt(options.h2,   randRange(1500000000, 1900000000), 'h2');
  const h3   = intOpt(options.h3,   randRange(1800000000, 2100000000), 'h3');
  const h4   = intOpt(options.h4,   randRange(2100000000, 2139000000), 'h4');
  const i1   = intOpt(options.i1,   randRange(600000000, 1500000000),  'i1');
  const i2   = intOpt(options.i2,   randRange(1500000000, 1900000000), 'i2');
  const i3   = intOpt(options.i3,   randRange(600000000, 1500000000),  'i3');
  const i4   = intOpt(options.i4,   randRange(1500000000, 1900000000), 'i4');
  const i5   = intOpt(options.i5,   randRange(600000000, 1500000000),  'i5');

  await buildImage(server, imageName, buildDir, DOCKERFILES.awg2);

  await execSudo(server, `mkdir -p /opt/amnezia/awg`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.awg2(subnetIp, subnetCidr, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/start.sh`);

  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await execSudo(server, [
    `docker run -d`,
    `--log-driver none`,
    `--restart always`,
    `--privileged`,
    `--cap-add=NET_ADMIN`,
    `--cap-add=SYS_MODULE`,
    `-p ${port}:${port}/udp`,
    `-v /lib/modules:/lib/modules`,
    `-v /opt/amnezia:/opt/amnezia`,
    `--sysctl="net.ipv4.conf.all.src_valid_mark=1"`,
    `--name ${containerName}`,
    imageName,
  ].join(' \\\n  '));
  await execSudo(server, `docker network create amnezia-dns-net 2>/dev/null || true`);
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);

  const awg2ConfigureScript = [
    `export AWG_SUBNET_IP=${subnetIp}`,
    `export WIREGUARD_SUBNET_CIDR=${subnetCidr}`,
    `export AWG_SERVER_PORT=${port}`,
    `export JUNK_PACKET_COUNT=${jc}`,
    `export JUNK_PACKET_MIN_SIZE=${jmin}`,
    `export JUNK_PACKET_MAX_SIZE=${jmax}`,
    `export INIT_PACKET_JUNK_SIZE=${s1}`,
    `export RESPONSE_PACKET_JUNK_SIZE=${s2}`,
    `export COOKIE_REPLY_PACKET_JUNK_SIZE=${s3}`,
    `export TRANSPORT_PACKET_JUNK_SIZE=${s4}`,
    `export INIT_PACKET_MAGIC_HEADER=${h1}`,
    `export RESPONSE_PACKET_MAGIC_HEADER=${h2}`,
    `export UNDERLOAD_PACKET_MAGIC_HEADER=${h3}`,
    `export TRANSPORT_PACKET_MAGIC_HEADER=${h4}`,
    `export SPECIAL_JUNK_1=${i1}`,
    `export SPECIAL_JUNK_2=${i2}`,
    `export SPECIAL_JUNK_3=${i3}`,
    `export SPECIAL_JUNK_4=${i4}`,
    `export SPECIAL_JUNK_5=${i5}`,
    '',
    CONFIGURE_SCRIPTS.awg2,
  ].join('\n');

  const awg2ConfigurePath = '/opt/amnezia/configure_awg.sh';
  await writeRemoteFile(server, awg2ConfigurePath, awg2ConfigureScript);
  const awg2ConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${awg2ConfigurePath}`);
  if (awg2ConfigureRes.code !== 0) {
    throw new Error(`AWG2 configure script failed (exit ${awg2ConfigureRes.code}): ${awg2ConfigureRes.stderr || awg2ConfigureRes.stdout}`);
  }

  // start.sh поднимает awg0 только если awg0.conf существует на момент старта
  // контейнера. При установке конфиг создаётся configure-скриптом ПОСЛЕ старта,
  // поэтому интерфейс остаётся не поднятым (awg set падает с "No such device").
  // Перезапускаем — теперь start.sh найдёт awg0.conf и поднимет интерфейс.
  const awg2RestartRes = await execSudo(server, `docker restart ${containerName}`);
  if (awg2RestartRes.code !== 0) {
    throw new Error(`Failed to restart AWG2 container after configure: ${awg2RestartRes.stderr || awg2RestartRes.stdout}`);
  }

  const serverPubKey = await readRemoteFile(server, '/opt/amnezia/awg/wireguard_server_public_key.key');
  if (!serverPubKey) throw new Error('AWG2 configure script did not generate server public key');

  const config: Awg2Config = {
    port, subnetIp, subnetCidr, serverPubKey,
    jc, jmin, jmax,
    s1, s2, s3, s4,
    h1: String(h1), h2: String(h2), h3: String(h3), h4: String(h4),
    i1: String(i1), i2: String(i2), i3: String(i3), i4: String(i4), i5: String(i5),
  };
  return { containerName, port, config };
}

export async function addAWG2Client(server: Server, protocol: Protocol, _clientName: string): Promise<AddClientResult> {
  assertContainerName(protocol.container_name);
  const c: any = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new Error('AWG2 protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`AWG2 container '${cn}' is not running. Start the protocol first.`);
  }

  const privRes = await execSudo(server, `docker exec ${cn} awg genkey`);
  if (privRes.code !== 0 || !privRes.stdout.trim()) {
    throw new Error(`Failed to generate AWG2 client private key: ${privRes.stderr || 'empty output'}`);
  }
  const clientPrivKey = privRes.stdout.trim();

  const pubRes = await execSudo(server, `echo '${clientPrivKey}' | docker exec -i ${cn} awg pubkey`);
  if (pubRes.code !== 0 || !pubRes.stdout.trim()) {
    throw new Error(`Failed to generate AWG2 client public key: ${pubRes.stderr || 'empty output'}`);
  }
  const clientPubKey = pubRes.stdout.trim();

  const pskRes = await execSudo(server, `docker exec ${cn} awg genpsk`);
  const presharedKey = pskRes.stdout.trim();
  if (!presharedKey) {
    throw new Error('Failed to generate AWG2 PSK: empty output');
  }

  const peersRes = await execSudo(server, `docker exec ${cn} awg show awg0 peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  const clientIp = `10.8.1.${peerCount + 2}`;

  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${cn} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);
  const addPeerRes = await execSudo(server, `docker exec ${cn} sh -c "awg set awg0 peer ${clientPubKey} preshared-key ${pskTmp} allowed-ips ${clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new Error(`Failed to add AWG2 peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  const awgPeerEntry = Buffer.from(`\n[Peer]\nPublicKey = ${clientPubKey}\nPresharedKey = ${presharedKey}\nAllowedIPs = ${clientIp}/32\n`).toString('base64');
  await execSudo(server, `echo '${awgPeerEntry}' | base64 -d | docker exec -i ${cn} tee -a /opt/amnezia/awg/awg0.conf > /dev/null`);

  const templateVars: Record<string, string | number> = {
    WIREGUARD_CLIENT_IP: clientIp,
    PRIMARY_DNS: '1.1.1.1',
    SECONDARY_DNS: '8.8.8.8',
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
    WIREGUARD_CLIENT_PUBLIC_KEY: clientPubKey,
    JUNK_PACKET_COUNT: c.jc ?? randInt(3, 10),
    JUNK_PACKET_MIN_SIZE: c.jmin ?? randInt(10, 50),
    JUNK_PACKET_MAX_SIZE: c.jmax ?? randInt(200, 1000),
    INIT_PACKET_JUNK_SIZE: c.s1 ?? randInt(100, 200),
    RESPONSE_PACKET_JUNK_SIZE: c.s2 ?? randInt(100, 200),
    COOKIE_REPLY_PACKET_JUNK_SIZE: c.s3 ?? randInt(30, 100),
    TRANSPORT_PACKET_JUNK_SIZE: c.s4 ?? randInt(10, 50),
    INIT_PACKET_MAGIC_HEADER: c.h1 ?? randRange(600000000, 1500000000),
    RESPONSE_PACKET_MAGIC_HEADER: c.h2 ?? randRange(1500000000, 1900000000),
    UNDERLOAD_PACKET_MAGIC_HEADER: c.h3 ?? randRange(1800000000, 2100000000),
    TRANSPORT_PACKET_MAGIC_HEADER: c.h4 ?? randRange(2100000000, 2139000000),
    SPECIAL_JUNK_1: c.i1 ?? randRange(600000000, 1500000000),
    SPECIAL_JUNK_2: c.i2 ?? randRange(1500000000, 1900000000),
    SPECIAL_JUNK_3: c.i3 ?? randRange(600000000, 1500000000),
    SPECIAL_JUNK_4: c.i4 ?? randRange(1500000000, 1900000000),
    SPECIAL_JUNK_5: c.i5 ?? randRange(600000000, 1500000000),
    WIREGUARD_SERVER_PUBLIC_KEY: c.serverPubKey,
    WIREGUARD_PSK: presharedKey,
    SERVER_IP_ADDRESS: server.host,
    AWG_SERVER_PORT: c.port,
  };

  const clientConf = renderTemplate(AWG2_CLIENT_TEMPLATE, templateVars);
  const configJson = renderTemplate(AWG2_CLIENT_JSON_TEMPLATE, templateVars);

  return { config: clientConf, configJson, type: 'awg2' };
}
