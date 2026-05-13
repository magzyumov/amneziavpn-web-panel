/**
 * protocols.js v4 — ТОЧНАЯ копия логики Amnezia Desktop Client
 *
 * Восстановлено из бинарника AmneziaVPN.app через reverse engineering.
 *
 * Как работает Amnezia:
 * 1. Копирует Dockerfile в /opt/amnezia/<proto>/ на VPS
 * 2. Делает docker build локально на VPS → образ amnezia-<proto>:latest
 * 3. Запускает контейнер с volume /opt/amnezia:/opt/amnezia
 * 4. Выполняет configure_container.sh внутри контейнера через docker exec
 *    с env-переменными — скрипт генерирует ключи и пишет конфиги
 * 5. Клиентский конфиг — шаблон с подстановкой переменных
 *
 * Ключи хранятся в файлах:
 *   /opt/amnezia/awg/wireguard_server_private_key.key
 *   /opt/amnezia/awg/wireguard_server_public_key.key
 *   /opt/amnezia/awg/wireguard_psk.key
 *   /opt/amnezia/xray/xray_uuid.key
 *   /opt/amnezia/xray/xray_public.key
 *   /opt/amnezia/xray/xray_private.key
 *   /opt/amnezia/xray/xray_short_id.key
 */

import { exec, execSudo } from './ssh.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Dockerfile'ы (вшиты в бинарник Amnezia, восстановлены) ─────────────────

const DOCKERFILES = {

  awg2: `FROM amneziavpn/amneziawg-go:latest

LABEL maintainer="AmneziaVPN"

#Install required packages
RUN apk add --no-cache bash curl dumb-init
RUN apk --update upgrade --no-cache

RUN mkdir -p /opt/amnezia
RUN echo -e "#!/bin/bash\\ntail -f /dev/null" > /opt/amnezia/start.sh
RUN chmod a+x /opt/amnezia/start.sh

# Tune network
RUN echo -e " \n\
  fs.file-max = 51200 \n\
  \n\
  net.core.rmem_max = 67108864 \n\
  net.core.wmem_max = 67108864 \n\
  net.core.netdev_max_backlog = 250000 \n\
  net.core.somaxconn = 4096 \n\
  \n\
  net.ipv4.tcp_syncookies = 1 \n\
  net.ipv4.tcp_tw_reuse = 1 \n\
  net.ipv4.tcp_tw_recycle = 0 \n\
  net.ipv4.tcp_fin_timeout = 30 \n\
  net.ipv4.tcp_keepalive_time = 1200 \n\
  net.ipv4.ip_local_port_range = 10000 65000 \n\
  net.ipv4.tcp_max_syn_backlog = 8192 \n\
  net.ipv4.tcp_max_tw_buckets = 5000 \n\
  net.ipv4.tcp_fastopen = 3 \n\
  net.ipv4.tcp_mem = 25600 51200 102400 \n\
  net.ipv4.tcp_rmem = 4096 87380 67108864 \n\
  net.ipv4.tcp_wmem = 4096 65536 67108864 \n\
  net.ipv4.tcp_mtu_probing = 1 \n\
  net.ipv4.tcp_congestion_control = hybla \n\
  # for low-latency network, use cubic instead \n\
  # net.ipv4.tcp_congestion_control = cubic \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/sysctl.conf && \
  mkdir -p /etc/security && \
  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/security/limits.conf

ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]
CMD [ "" ]`,

  xray: `FROM alpine:3.15
LABEL maintainer="AmneziaVPN"

ARG XRAY_RELEASE="v25.8.3"

RUN apk add --no-cache curl unzip bash openssl netcat-openbsd dumb-init rng-tools xz
RUN apk --update upgrade --no-cache

RUN mkdir -p /opt/amnezia
RUN echo -e "#!/bin/bash\\ntail -f /dev/null" > /opt/amnezia/start.sh
RUN chmod a+x /opt/amnezia/start.sh

RUN mkdir -p /opt/amnezia/xray

RUN curl -L https://github.com/XTLS/Xray-core/releases/download/\${XRAY_RELEASE}/Xray-linux-64.zip > /root/xray.zip;\\\n  unzip /root/xray.zip -d /usr/bin/;\\\n  chmod a+x /usr/bin/xray;

# Tune network
RUN echo -e " \n\
  fs.file-max = 51200 \n\
  \n\
  net.core.rmem_max = 67108864 \n\
  net.core.wmem_max = 67108864 \n\
  net.core.netdev_max_backlog = 250000 \n\
  net.core.somaxconn = 4096 \n\
  net.core.default_qdisc=fq \n\
  \n\
  net.ipv4.tcp_syncookies = 1 \n\
  net.ipv4.tcp_tw_reuse = 1 \n\
  net.ipv4.tcp_tw_recycle = 0 \n\
  net.ipv4.tcp_fin_timeout = 30 \n\
  net.ipv4.tcp_keepalive_time = 1200 \n\
  net.ipv4.ip_local_port_range = 10000 65000 \n\
  net.ipv4.tcp_max_syn_backlog = 8192 \n\
  net.ipv4.tcp_max_tw_buckets = 5000 \n\
  net.ipv4.tcp_fastopen = 3 \n\
  net.ipv4.tcp_mem = 25600 51200 102400 \n\
  net.ipv4.tcp_rmem = 4096 87380 67108864 \n\
  net.ipv4.tcp_wmem = 4096 65536 67108864 \n\
  net.ipv4.tcp_mtu_probing = 1 \n\
  net.ipv4.tcp_congestion_control = bbr \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/sysctl.conf && \\\n  mkdir -p /etc/security && \\\n  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/security/limits.conf

ENV TZ=Asia/Shanghai

ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]`,

  wireguard: `FROM alpine:3.15

LABEL maintainer="AmneziaVPN"

#Install required packages
RUN apk add --no-cache curl wireguard-tools dumb-init
RUN apk --update upgrade --no-cache

RUN mkdir -p /opt/amnezia
RUN echo -e "#!/bin/bash\\ntail -f /dev/null" > /opt/amnezia/start.sh
RUN chmod a+x /opt/amnezia/start.sh

# Tune network
RUN echo -e " \n\
  fs.file-max = 51200 \n\
  \n\
  net.core.rmem_max = 67108864 \n\
  net.core.wmem_max = 67108864 \n\
  net.core.netdev_max_backlog = 250000 \n\
  net.core.somaxconn = 4096 \n\
  \n\
  net.ipv4.tcp_syncookies = 1 \n\
  net.ipv4.tcp_tw_reuse = 1 \n\
  net.ipv4.tcp_tw_recycle = 0 \n\
  net.ipv4.tcp_fin_timeout = 30 \n\
  net.ipv4.tcp_keepalive_time = 1200 \n\
  net.ipv4.ip_local_port_range = 10000 65000 \n\
  net.ipv4.tcp_max_syn_backlog = 8192 \n\
  net.ipv4.tcp_max_tw_buckets = 5000 \n\
  net.ipv4.tcp_fastopen = 3 \n\
  net.ipv4.tcp_mem = 25600 51200 102400 \n\
  net.ipv4.tcp_rmem = 4096 87380 67108864 \n\
  net.ipv4.tcp_wmem = 4096 65536 67108864 \n\
  net.ipv4.tcp_mtu_probing = 1 \n\
  net.ipv4.tcp_congestion_control = hybla \n\
  # for low-latency network, use cubic instead \n\
  # net.ipv4.tcp_congestion_control = cubic \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/sysctl.conf && \
  mkdir -p /etc/security && \
  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\s\+//g' | tee -a /etc/security/limits.conf

ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]
CMD [ "" ]`,
};

// ─── start.sh скрипты (восстановлены из бинарника) ──────────────────────────

const START_SCRIPTS = {

  // Script #13 из бинарника — AWG2
  awg2: (subnetIp, subnetCidr, serverIp) => `#!/bin/bash

# This scripts copied from Amnezia client to Docker container to /opt/amnezia and launched every time container starts

echo "Container startup"
#ifconfig eth0:0 ${serverIp} netmask 255.255.255.255 up

# kill daemons in case of restart
awg-quick down /opt/amnezia/awg/awg0.conf

# start daemons if configured
if [ -f /opt/amnezia/awg/awg0.conf ]; then (awg-quick up /opt/amnezia/awg/awg0.conf); fi

# Allow traffic on the TUN interface.
iptables -A INPUT -i awg0 -j ACCEPT
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A OUTPUT -o awg0 -j ACCEPT

# Allow forwarding traffic only from the VPN.
iptables -A FORWARD -i awg0 -o eth0 -s ${subnetIp}/${subnetCidr} -j ACCEPT
iptables -A FORWARD -i awg0 -o eth1 -s ${subnetIp}/${subnetCidr} -j ACCEPT

iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -t nat -A POSTROUTING -s ${subnetIp}/${subnetCidr} -o eth0 -j MASQUERADE
iptables -t nat -A POSTROUTING -s ${subnetIp}/${subnetCidr} -o eth1 -j MASQUERADE

tail -f /dev/null`,

  // Script #15 из бинарника — Xray
  xray: (port, serverIp) => `#!/bin/bash
# This scripts copied from Amnezia client to Docker container to /opt/amnezia and launched every time container starts
echo "Container startup"
#ifconfig eth0:0 ${serverIp} netmask 255.255.255.255 up
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p icmp -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport ${port} -j ACCEPT
iptables -P INPUT DROP
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -P INPUT DROP
# kill daemons in case of restart
killall -KILL xray
# start daemons if configured
if [ -f /opt/amnezia/xray/server.json ]; then (xray -config /opt/amnezia/xray/server.json); fi
tail -f /dev/null`,

  // Script #9 из бинарника — WireGuard
  wireguard: (subnetIp, subnetCidr, serverIp) => `#!/bin/bash

# This scripts copied from Amnezia client to Docker container to /opt/amnezia and launched every time container starts

echo "Container startup"
#ifconfig eth0:0 ${serverIp} netmask 255.255.255.255 up

# kill daemons in case of restart
wg-quick down /opt/amnezia/wireguard/wg0.conf

# start daemons if configured
if [ -f /opt/amnezia/wireguard/wg0.conf ]; then (wg-quick up /opt/amnezia/wireguard/wg0.conf); fi

# Allow traffic on the TUN interface.
iptables -A INPUT -i wg0 -j ACCEPT
iptables -A FORWARD -i wg0 -j ACCEPT
iptables -A OUTPUT -o wg0 -j ACCEPT

# Allow forwarding traffic only from the VPN.
iptables -A FORWARD -i wg0 -o eth0 -s ${subnetIp}/${subnetCidr} -j ACCEPT
iptables -A FORWARD -i wg0 -o eth1 -s ${subnetIp}/${subnetCidr} -j ACCEPT

iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -t nat -A POSTROUTING -s ${subnetIp}/${subnetCidr} -o eth0 -j MASQUERADE
iptables -t nat -A POSTROUTING -s ${subnetIp}/${subnetCidr} -o eth1 -j MASQUERADE

tail -f /dev/null`,
};

// ─── configure_container.sh скрипты (восстановлены из бинарника) ────────────
// Выполняются внутри контейнера через docker exec с env-переменными

const CONFIGURE_SCRIPTS = {

  // Block #7 из бинарника — AWG2 configure
  awg2: `mkdir -p /opt/amnezia/awg
cd /opt/amnezia/awg
WIREGUARD_SERVER_PRIVATE_KEY=$(awg genkey)
echo $WIREGUARD_SERVER_PRIVATE_KEY > /opt/amnezia/awg/wireguard_server_private_key.key

WIREGUARD_SERVER_PUBLIC_KEY=$(echo $WIREGUARD_SERVER_PRIVATE_KEY | awg pubkey)
echo $WIREGUARD_SERVER_PUBLIC_KEY > /opt/amnezia/awg/wireguard_server_public_key.key

WIREGUARD_PSK=$(awg genpsk)
echo $WIREGUARD_PSK > /opt/amnezia/awg/wireguard_psk.key

cat > /opt/amnezia/awg/awg0.conf <<EOF
[Interface]
PrivateKey = $WIREGUARD_SERVER_PRIVATE_KEY
Address = $AWG_SUBNET_IP/$WIREGUARD_SUBNET_CIDR
ListenPort = $AWG_SERVER_PORT
Jc = $JUNK_PACKET_COUNT
Jmin = $JUNK_PACKET_MIN_SIZE
Jmax = $JUNK_PACKET_MAX_SIZE
S1 = $INIT_PACKET_JUNK_SIZE
S2 = $RESPONSE_PACKET_JUNK_SIZE
S3 = $COOKIE_REPLY_PACKET_JUNK_SIZE
S4 = $TRANSPORT_PACKET_JUNK_SIZE
H1 = $INIT_PACKET_MAGIC_HEADER
H2 = $RESPONSE_PACKET_MAGIC_HEADER
H3 = $UNDERLOAD_PACKET_MAGIC_HEADER
H4 = $TRANSPORT_PACKET_MAGIC_HEADER
# I1 = $SPECIAL_JUNK_1
# I2 = $SPECIAL_JUNK_2
# I3 = $SPECIAL_JUNK_3
# I4 = $SPECIAL_JUNK_4
# I5 = $SPECIAL_JUNK_5
EOF`,

  // Block #5 из бинарника — WireGuard configure
  wireguard: `mkdir -p /opt/amnezia/wireguard
cd /opt/amnezia/wireguard
WIREGUARD_SERVER_PRIVATE_KEY=$(wg genkey)
echo $WIREGUARD_SERVER_PRIVATE_KEY > /opt/amnezia/wireguard/wireguard_server_private_key.key

WIREGUARD_SERVER_PUBLIC_KEY=$(echo $WIREGUARD_SERVER_PRIVATE_KEY | wg pubkey)
echo $WIREGUARD_SERVER_PUBLIC_KEY > /opt/amnezia/wireguard/wireguard_server_public_key.key

WIREGUARD_PSK=$(wg genpsk)
echo $WIREGUARD_PSK > /opt/amnezia/wireguard/wireguard_psk.key

cat > /opt/amnezia/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $WIREGUARD_SERVER_PRIVATE_KEY
Address = $WIREGUARD_SUBNET_IP/$WIREGUARD_SUBNET_CIDR
ListenPort = $WIREGUARD_SERVER_PORT
EOF`,

  // Block #10 из бинарника — Xray configure
  xray: `cd /opt/amnezia/xray

XRAY_CLIENT_ID=$(xray uuid) && echo $XRAY_CLIENT_ID > /opt/amnezia/xray/xray_uuid.key
XRAY_SHORT_ID=$(openssl rand -hex 8) && echo $XRAY_SHORT_ID > /opt/amnezia/xray/xray_short_id.key
KEYPAIR=$(xray x25519)
LINE_NUM=1
while IFS= read -r line; do
    if [[ $LINE_NUM -gt 1 ]]; then
        IFS=":" read FIST XRAY_PUBLIC_KEY <<< "$line"
    else
        LINE_NUM=$((LINE_NUM + 1))
        IFS=":" read FIST XRAY_PRIVATE_KEY <<< "$line"
    fi
done <<< "$KEYPAIR"
XRAY_PRIVATE_KEY=$(echo $XRAY_PRIVATE_KEY | tr -d ' ')
XRAY_PUBLIC_KEY=$(echo $XRAY_PUBLIC_KEY | tr -d ' ')
echo $XRAY_PUBLIC_KEY > /opt/amnezia/xray/xray_public.key
echo $XRAY_PRIVATE_KEY > /opt/amnezia/xray/xray_private.key
cat > /opt/amnezia/xray/server.json <<EOF
{
    "log": { "loglevel": "error" },
    "inbounds": [{
        "port": $XRAY_SERVER_PORT,
        "protocol": "vless",
        "settings": {
            "clients": [{ "id": "$XRAY_CLIENT_ID", "flow": "xtls-rprx-vision" }],
            "decryption": "none"
        },
        "streamSettings": {
            "network": "tcp",
            "security": "reality",
            "realitySettings": {
                "dest": "$XRAY_SITE_NAME:443",
                "serverNames": ["$XRAY_SITE_NAME"],
                "privateKey": "$XRAY_PRIVATE_KEY",
                "shortIds": ["$XRAY_SHORT_ID"]
            }
        }
    }],
    "outbounds": [{ "protocol": "freedom" }]
}
EOF`,
};

// ─── Шаблоны клиентских конфигов (из бинарника) ─────────────────────────────

// Block #6 — AWG2 клиент (с S3, S4)
const AWG2_CLIENT_TEMPLATE = `[Interface]
Address = $WIREGUARD_CLIENT_IP/32
DNS = $PRIMARY_DNS, $SECONDARY_DNS
PrivateKey = $WIREGUARD_CLIENT_PRIVATE_KEY
Jc = $JUNK_PACKET_COUNT
Jmin = $JUNK_PACKET_MIN_SIZE
Jmax = $JUNK_PACKET_MAX_SIZE
S1 = $INIT_PACKET_JUNK_SIZE
S2 = $RESPONSE_PACKET_JUNK_SIZE
S3 = $COOKIE_REPLY_PACKET_JUNK_SIZE
S4 = $TRANSPORT_PACKET_JUNK_SIZE
H1 = $INIT_PACKET_MAGIC_HEADER
H2 = $RESPONSE_PACKET_MAGIC_HEADER
H3 = $UNDERLOAD_PACKET_MAGIC_HEADER
H4 = $TRANSPORT_PACKET_MAGIC_HEADER
I1 = $SPECIAL_JUNK_1
I2 = $SPECIAL_JUNK_2
I3 = $SPECIAL_JUNK_3
I4 = $SPECIAL_JUNK_4
I5 = $SPECIAL_JUNK_5

[Peer]
PublicKey = $WIREGUARD_SERVER_PUBLIC_KEY
PresharedKey = $WIREGUARD_PSK
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $SERVER_IP_ADDRESS:$AWG_SERVER_PORT
PersistentKeepalive = 25`;

// Block #4 — WireGuard клиент
const WG_CLIENT_TEMPLATE = `[Interface]
Address = $WIREGUARD_CLIENT_IP/32
DNS = $PRIMARY_DNS, $SECONDARY_DNS
PrivateKey = $WIREGUARD_CLIENT_PRIVATE_KEY

[Peer]
PublicKey = $WIREGUARD_SERVER_PUBLIC_KEY
PresharedKey = $WIREGUARD_PSK
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $SERVER_IP_ADDRESS:$WIREGUARD_SERVER_PORT
PersistentKeepalive = 25`;

// Block #9 — Xray клиент JSON (для импорта в AmneziaVPN)
const XRAY_CLIENT_TEMPLATE = `{
    "log": { "loglevel": "error" },
    "inbounds": [{
        "listen": "127.0.0.1",
        "port": 10808,
        "protocol": "socks",
        "settings": { "udp": true }
    }],
    "outbounds": [{
        "protocol": "vless",
        "settings": {
            "vnext": [{
                "address": "$SERVER_IP_ADDRESS",
                "port": $XRAY_SERVER_PORT,
                "users": [{
                    "id": "$XRAY_CLIENT_ID",
                    "flow": "xtls-rprx-vision",
                    "encryption": "none"
                }]
            }]
        },
        "streamSettings": {
            "network": "tcp",
            "security": "reality",
            "realitySettings": {
                "fingerprint": "chrome",
                "serverName": "$XRAY_SITE_NAME",
                "publicKey": "$XRAY_PUBLIC_KEY",
                "shortId": "$XRAY_SHORT_ID",
                "spiderX": ""
            }
        }
    }]
}`;

// Amnezia JSON для AWG2 (импорт в десктопный AmneziaVPN)
const AWG2_CLIENT_JSON_TEMPLATE = `{
    "container": "amnezia-awg2",
    "host": "$SERVER_IP_ADDRESS",
    "port": "$AWG_SERVER_PORT",
    "type": "awg2",
    "config": {
        "address": "$WIREGUARD_CLIENT_IP/32",
        "dns": "$PRIMARY_DNS, $SECONDARY_DNS",
        "private_key": "$WIREGUARD_CLIENT_PRIVATE_KEY",
        "public_key": "$WIREGUARD_SERVER_PUBLIC_KEY",
        "psk": "$WIREGUARD_PSK",
        "jc": "$JUNK_PACKET_COUNT",
        "jmin": "$JUNK_PACKET_MIN_SIZE",
        "jmax": "$JUNK_PACKET_MAX_SIZE",
        "s1": "$INIT_PACKET_JUNK_SIZE",
        "s2": "$RESPONSE_PACKET_JUNK_SIZE",
        "s3": "$COOKIE_REPLY_PACKET_JUNK_SIZE",
        "s4": "$TRANSPORT_PACKET_JUNK_SIZE",
        "h1": "$INIT_PACKET_MAGIC_HEADER",
        "h2": "$RESPONSE_PACKET_MAGIC_HEADER",
        "h3": "$UNDERLOAD_PACKET_MAGIC_HEADER",
        "h4": "$TRANSPORT_PACKET_MAGIC_HEADER",
        "i1": "$SPECIAL_JUNK_1",
        "i2": "$SPECIAL_JUNK_2",
        "i3": "$SPECIAL_JUNK_3",
        "i4": "$SPECIAL_JUNK_4",
        "i5": "$SPECIAL_JUNK_5"
    }
}`;

// Amnezia JSON для WireGuard (импорт в десктопный AmneziaVPN)
const WG_CLIENT_JSON_TEMPLATE = `{
    "container": "amnezia-wireguard",
    "host": "$SERVER_IP_ADDRESS",
    "port": "$WIREGUARD_SERVER_PORT",
    "type": "wireguard",
    "config": {
        "address": "$WIREGUARD_CLIENT_IP/32",
        "dns": "$PRIMARY_DNS, $SECONDARY_DNS",
        "private_key": "$WIREGUARD_CLIENT_PRIVATE_KEY",
        "public_key": "$WIREGUARD_SERVER_PUBLIC_KEY",
        "psk": "$WIREGUARD_PSK"
    }
}`;

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randRange(min, max) {
  const a = randInt(min, max), b = randInt(min, max);
  return `${Math.min(a,b)}-${Math.max(a,b)}`;
}
function randPort() { return randInt(10000, 62000); }

// Запись файла через base64 — без проблем с экранированием
async function writeRemoteFile(server, remotePath, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const tmp = `/tmp/.amnezia_${Date.now()}`;
  // Пишем base64 по кускам
  const chunkSize = 4000;
  await execSudo(server, `printf '' > ${tmp}.b64`);
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    await execSudo(server, `printf '%s' '${chunk}' >> ${tmp}.b64`);
  }
  await execSudo(server, `base64 -d ${tmp}.b64 > ${remotePath} && rm -f ${tmp}.b64`);
}

// Чтение файла с удалённого сервера
async function readRemoteFile(server, remotePath) {
  const res = await execSudo(server, `cat ${remotePath} 2>/dev/null`);
  return res.stdout.trim();
}

// Чтение файла из внутренности Docker-контейнера
async function readContainerFile(server, containerName, remotePath) {
  const res = await execSudo(server, `docker exec ${containerName} cat ${remotePath} 2>/dev/null`);
  return res.stdout.trim();
}

// Проверяем что образ уже собран
async function imageExists(server, imageName) {
  const res = await exec(server, `docker image inspect ${imageName} --format='exists' 2>/dev/null || echo ""`);
  return res.stdout.trim() === 'exists';
}

// Сборка образа из Dockerfile
async function buildImage(server, imageName, buildDir, dockerfile) {
  if (await imageExists(server, imageName)) return;
  await execSudo(server, `mkdir -p ${buildDir}`);
  await writeRemoteFile(server, `${buildDir}/Dockerfile`, dockerfile);
  const res = await execSudo(server, `docker build -t ${imageName} ${buildDir} 2>&1`);
  if (res.code !== 0) {
    throw new Error(`docker build failed:\n${res.stdout.slice(-2000)}`);
  }
}

// Подстановка переменных в шаблон
function renderTemplate(template, vars) {
  return Object.entries(vars).reduce((str, [k, v]) =>
    str.replaceAll(`$${k}`, String(v)), template);
}

// ─── AWG 2.0 ─────────────────────────────────────────────────────────────────

export async function installAWG2(server, options = {}) {
  const port      = options.port   || randPort();
  const subnetIp  = '10.8.1.0';
  const subnetCidr = '24';
  const subnet    = `${subnetIp}/${subnetCidr}`;
  const containerName = 'amnezia-awg2';
  const imageName = 'amnezia-awg2:latest';
  const buildDir  = '/opt/amnezia/amnezia-awg2';

  // Параметры обфускации AWG2
  const jc   = options.jc   ?? randInt(3, 10);
  const jmin = options.jmin ?? randInt(10, 50);
  const jmax = options.jmax ?? randInt(200, 1000);
  const s1   = options.s1   ?? randInt(100, 200);
  const s2   = options.s2   ?? randInt(100, 200);
  const s3   = options.s3   ?? randInt(30, 100);
  const s4   = options.s4   ?? randInt(10, 50);
  const h1   = options.h1   ?? randRange(600000000, 1500000000);
  const h2   = options.h2   ?? randRange(1500000000, 1900000000);
  const h3   = options.h3   ?? randRange(1800000000, 2100000000);
  const h4   = options.h4   ?? randRange(2100000000, 2139000000);
  const i1   = options.i1   ?? randRange(600000000, 1500000000);
  const i2   = options.i2   ?? randRange(1500000000, 1900000000);
  const i3   = options.i3   ?? randRange(600000000, 1500000000);
  const i4   = options.i4   ?? randRange(1500000000, 1900000000);
  const i5   = options.i5   ?? randRange(600000000, 1500000000);

  // 1. Собираем образ если нет
  await buildImage(server, imageName, buildDir, DOCKERFILES.awg2);

  // 2. Пишем start.sh (будет примонтирован через volume)
  await execSudo(server, `mkdir -p /opt/amnezia/awg`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.awg2(subnetIp, subnetCidr, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/start.sh`);

  // 3. Запускаем контейнер
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

  // Prevent to route packets outside of the container in case if server behind of the NAT
  // await execSudo(server, `docker exec -i ${containerName} sh -c "ifconfig eth0:0 ${server.host} netmask 255.255.255.255 up"`);

  // 4. Выполняем configure_container.sh внутри контейнера
  // Пишем скрипт через base64 (без проблем с экранированием), добавляем export'ы в начало
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

  // 5. Читаем сгенерированные ключи и проверяем что они не пустые
  const serverPubKey = await readRemoteFile(server, '/opt/amnezia/awg/wireguard_server_public_key.key');
  if (!serverPubKey) throw new Error('AWG2 configure script did not generate server public key');

  return {
    containerName,
    port,
    config: {
      port, subnetIp, subnetCidr, serverPubKey,
      jc, jmin, jmax, s1, s2, s3, s4,
      h1: String(h1), h2: String(h2), h3: String(h3), h4: String(h4),
      i1: String(i1), i2: String(i2), i3: String(i3), i4: String(i4), i5: String(i5),
    },
  };
}

export async function addAWG2Client(server, protocol, clientName) {
  const c  = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new Error('AWG2 protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  // Проверяем что контейнер запущен
  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`AWG2 container '${cn}' is not running. Start the protocol first.`);
  }

  // Генерируем ключи клиента внутри контейнера
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

  // Определяем IP клиента
  const peersRes = await execSudo(server, `docker exec ${cn} awg show awg0 peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  const clientIp = `10.8.1.${peerCount + 2}`;

  // Добавляем peer в живой интерфейс
  // Пишем PSK прямо внутрь контейнера через docker exec
  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${cn} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);
  const addPeerRes = await execSudo(server, `docker exec ${cn} sh -c "awg set awg0 peer ${clientPubKey} preshared-key ${pskTmp} allowed-ips ${clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new Error(`Failed to add AWG2 peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  // Дописываем peer в серверный конфиг
  await execSudo(server, `printf '\\n[Peer]\\nPublicKey = ${clientPubKey}\\nPresharedKey = ${presharedKey}\\nAllowedIPs = ${clientIp}/32\\n' >> /opt/amnezia/awg/awg0.conf`);

  // Общие параметры шаблона
  const templateVars = {
    WIREGUARD_CLIENT_IP: clientIp,
    PRIMARY_DNS: '1.1.1.1',
    SECONDARY_DNS: '8.8.8.8',
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
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

  // Генерируем .conf для WireGuard клиентов и Amnezia JSON для десктопного приложения
  const clientConf = renderTemplate(AWG2_CLIENT_TEMPLATE, templateVars);
  const configJson = renderTemplate(AWG2_CLIENT_JSON_TEMPLATE, templateVars);

  return { config: clientConf, configJson, type: 'awg2' };
}

// ─── Xray VLESS Reality ───────────────────────────────────────────────────────

export async function installXray(server, options = {}) {
  const port = options.port ?? 443;
  const sni  = options.sni  ?? 'www.googletagmanager.com';
  const containerName = 'amnezia-xray';
  const imageName = 'amnezia-xray:latest';
  const buildDir = '/opt/amnezia/amnezia-xray';

  // 1. Собираем образ
  await buildImage(server, imageName, buildDir, DOCKERFILES.xray);

  // 2. start.sh
  await execSudo(server, `mkdir -p /opt/amnezia/xray`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.xray(port, server.host));
  await execSudo(server, `chmod +x /opt/amnezia/start.sh`);

  // 3. Запускаем контейнер
  await execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
  await execSudo(server, [
    `docker run -d`,
    `--name ${containerName}`,
    `--restart always`,
    `--privileged`,
    `--log-driver none`,
    `--cap-add NET_ADMIN`,
    `-v /opt/amnezia:/opt/amnezia`,
    `-p ${port}:${port}/tcp`,
    imageName,
  ].join(' \\\n  '));
  await execSudo(server, `docker network create amnezia-dns-net 2>/dev/null || true`);
  await execSudo(server, `docker network connect amnezia-dns-net ${containerName}`);
  // Создаём TUN device если нет
  await execSudo(server, `docker exec -i ${containerName} bash -c 'mkdir -p /dev/net; if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200; fi'`);

  // 4. configure_container.sh внутри контейнера
  const xrayConfigureScript = [
    `export XRAY_SERVER_PORT=${port}`,
    `export XRAY_SITE_NAME=${sni}`,
    '',
    CONFIGURE_SCRIPTS.xray,
  ].join('\n');

  const xrayConfigurePath = '/opt/amnezia/configure_xray.sh';
  await writeRemoteFile(server, xrayConfigurePath, xrayConfigureScript);
  const xrayConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${xrayConfigurePath}`);
  if (xrayConfigureRes.code !== 0) {
    throw new Error(`Xray configure script failed (exit ${xrayConfigureRes.code}): ${xrayConfigureRes.stderr || xrayConfigureRes.stdout}`);
  }

  // 5. Читаем сгенерированные ключи и проверяем что они не пустые
  const publicKey = await readRemoteFile(server, '/opt/amnezia/xray/xray_public.key');
  const shortId   = await readRemoteFile(server, '/opt/amnezia/xray/xray_short_id.key');
  const firstUuid = await readRemoteFile(server, '/opt/amnezia/xray/xray_uuid.key');
  if (!publicKey) throw new Error('Xray configure script did not generate public key');
  if (!shortId)   throw new Error('Xray configure script did not generate short ID');
  if (!firstUuid) throw new Error('Xray configure script did not generate UUID');

  return {
    containerName,
    port,
    config: { port, sni, publicKey, shortId, firstUuid },
  };
}

export async function addXrayClient(server, protocol, clientName) {
  const c  = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  // Проверяем что контейнер запущен
  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`Xray container '${cn}' is not running. Start the protocol first.`);
  }

  // Генерируем новый UUID внутри контейнера
  const uuidRes = await execSudo(server, `docker exec ${cn} xray uuid`);
  if (uuidRes.code !== 0 || !uuidRes.stdout.trim()) {
    throw new Error(`Failed to generate Xray UUID: ${uuidRes.stderr || 'empty output. Check that xray binary is installed in the container.'}`);
  }
  const clientId = uuidRes.stdout.trim();

  // Читаем и обновляем server.json
  const confRes = await execSudo(server, `cat /opt/amnezia/xray/server.json`);
  if (confRes.code !== 0 || !confRes.stdout.trim()) {
    throw new Error('Xray server.json not found on VPS. The protocol may not have been configured correctly. Reinstall the protocol.');
  }

  let serverJson;
  try {
    serverJson = JSON.parse(confRes.stdout);
  } catch (e) {
    throw new Error(`Failed to parse Xray server.json: ${e.message}. File content may be corrupted. Reinstall the protocol.`);
  }

  if (!serverJson.inbounds?.[0]?.settings?.clients) {
    throw new Error('Unexpected structure in Xray server.json. Reinstall the protocol.');
  }

  serverJson.inbounds[0].settings.clients.push({ id: clientId, flow: 'xtls-rprx-vision' });
  await writeRemoteFile(server, `/opt/amnezia/xray/server.json`, JSON.stringify(serverJson, null, 4));

  // Перезапускаем контейнер для применения изменений
  const restartRes = await execSudo(server, `docker restart ${cn}`);
  if (restartRes.code !== 0) {
    throw new Error(`Failed to restart Xray container: ${restartRes.stderr}`);
  }

  // Генерируем клиентский конфиг
  const safeName = clientName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const port    = c.port;
  const sni     = c.sni;
  const pubKey  = c.publicKey;
  const shortId = c.shortId;

  if (!port || !sni || !pubKey || !shortId) {
    throw new Error('Xray protocol config is incomplete (missing port/sni/publicKey/shortId). Reinstall the protocol.');
  }

  // VLESS URI для AmneziaVPN / FLClash
  const vlessUrl = `vless://${clientId}@${server.host}:${port}?type=tcp&security=reality&pbk=${pubKey}&fp=chrome&sni=${sni}&sid=${shortId}&flow=xtls-rprx-vision#${safeName}`;

  // JSON конфиг (формат Amnezia)
  const clientJson = renderTemplate(XRAY_CLIENT_TEMPLATE, {
    SERVER_IP_ADDRESS: server.host,
    XRAY_SERVER_PORT: port,
    XRAY_CLIENT_ID: clientId,
    XRAY_SITE_NAME: sni,
    XRAY_PUBLIC_KEY: pubKey,
    XRAY_SHORT_ID: shortId,
  });

  return { config: vlessUrl, configJson: clientJson, type: 'xray' };
}

// ─── WireGuard classic ────────────────────────────────────────────────────────

export async function installWireGuard(server, options = {}) {
  const port      = options.port   || randPort();
  const subnetIp  = '10.8.1.0';
  const subnetCidr = '24';
  const containerName = 'amnezia-wireguard';
  const imageName = 'amnezia-wireguard:latest';
  const buildDir  = '/opt/amnezia/amnezia-wireguard';

  await buildImage(server, imageName, buildDir, DOCKERFILES.wireguard);

  await execSudo(server, `mkdir -p /opt/amnezia/wireguard`);
  await writeRemoteFile(server, `/opt/amnezia/start.sh`, START_SCRIPTS.wireguard(subnetIp, subnetCidr, server.host));
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

  // Prevent to route packets outside of the container in case if server behind of the NAT
  // await execSudo(server, `docker exec -i ${containerName} sh -c "ifconfig eth0:0 ${server.host} netmask 255.255.255.255 up"`);

  const wgConfigureScript = [
    `export WIREGUARD_SUBNET_IP=${subnetIp}`,
    `export WIREGUARD_SUBNET_CIDR=${subnetCidr}`,
    `export WIREGUARD_SERVER_PORT=${port}`,
    '',
    CONFIGURE_SCRIPTS.wireguard,
  ].join('\n');

  const wgConfigurePath = '/opt/amnezia/configure_wg.sh';
  await writeRemoteFile(server, wgConfigurePath, wgConfigureScript);
  const wgConfigureRes = await execSudo(server, `docker exec ${containerName} bash ${wgConfigurePath}`);
  if (wgConfigureRes.code !== 0) {
    throw new Error(`WireGuard configure script failed (exit ${wgConfigureRes.code}): ${wgConfigureRes.stderr || wgConfigureRes.stdout}`);
  }

  const serverPubKey = await readRemoteFile(server, '/opt/amnezia/wireguard/wireguard_server_public_key.key');
  if (!serverPubKey) throw new Error('WireGuard configure script did not generate server public key');

  return {
    containerName,
    port,
    config: { port, subnetIp, subnetCidr, serverPubKey },
  };
}

export async function addWireGuardClient(server, protocol, clientName) {
  const c  = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;
  const cn = protocol.container_name;

  if (!c.serverPubKey || !c.port) {
    throw new Error('WireGuard protocol config is incomplete (missing serverPubKey or port). Reinstall the protocol.');
  }

  // Проверяем что контейнер запущен
  const statusRes = await exec(server, `docker inspect --format='{{.State.Status}}' ${cn} 2>/dev/null || echo ''`);
  if (statusRes.stdout.trim() !== 'running') {
    throw new Error(`WireGuard container '${cn}' is not running. Start the protocol first.`);
  }

  const privRes = await execSudo(server, `docker exec ${cn} wg genkey`);
  if (privRes.code !== 0 || !privRes.stdout.trim()) {
    throw new Error(`Failed to generate WireGuard client private key: ${privRes.stderr || 'empty output'}`);
  }
  const clientPrivKey = privRes.stdout.trim();

  const pubRes = await execSudo(server, `echo '${clientPrivKey}' | docker exec -i ${cn} wg pubkey`);
  if (pubRes.code !== 0 || !pubRes.stdout.trim()) {
    throw new Error(`Failed to generate WireGuard client public key: ${pubRes.stderr || 'empty output'}`);
  }
  const clientPubKey = pubRes.stdout.trim();

  // Читаем server PSK
  const presharedKey = await readRemoteFile(server, '/opt/amnezia/wireguard/wireguard_psk.key');
  if (!presharedKey) {
    throw new Error('WireGuard PSK not found on server. Reinstall the protocol.');
  }

  const peersRes = await execSudo(server, `docker exec ${cn} wg show wg0 peers 2>/dev/null | wc -l`);
  const peerCount = parseInt(peersRes.stdout.trim()) || 0;
  const clientIp = `10.8.1.${peerCount + 2}`;

  // Пишем PSK прямо внутрь контейнера через docker exec
  const pskTmp = `/tmp/.psk_${Date.now()}`;
  const pskB64 = Buffer.from(presharedKey, 'utf8').toString('base64');
  await execSudo(server, `docker exec ${cn} sh -c "echo '${pskB64}' | base64 -d > ${pskTmp}"`);
  const addPeerRes = await execSudo(server, `docker exec ${cn} sh -c "wg set wg0 peer ${clientPubKey} preshared-key ${pskTmp} allowed-ips ${clientIp}/32 && rm -f ${pskTmp}"`);
  if (addPeerRes.code !== 0) {
    throw new Error(`Failed to add WireGuard peer: ${addPeerRes.stderr || addPeerRes.stdout}`);
  }

  await execSudo(server, `printf '\\n[Peer]\\nPublicKey = ${clientPubKey}\\nPresharedKey = ${presharedKey}\\nAllowedIPs = ${clientIp}/32\\n' >> /opt/amnezia/wireguard/wg0.conf`);

  const templateVars = {
    WIREGUARD_CLIENT_IP: clientIp,
    PRIMARY_DNS: '1.1.1.1',
    SECONDARY_DNS: '8.8.8.8',
    WIREGUARD_CLIENT_PRIVATE_KEY: clientPrivKey,
    WIREGUARD_SERVER_PUBLIC_KEY: c.serverPubKey,
    WIREGUARD_PSK: presharedKey,
    SERVER_IP_ADDRESS: server.host,
    WIREGUARD_SERVER_PORT: c.port,
  };

  const clientConf = renderTemplate(WG_CLIENT_TEMPLATE, templateVars);
  const configJson = renderTemplate(WG_CLIENT_JSON_TEMPLATE, templateVars);

  return { config: clientConf, configJson, type: 'wireguard' };
}

// ─── Container management ─────────────────────────────────────────────────────

export async function getContainerStatus(server, containerName) {
  const res = await exec(server, `docker inspect --format='{{.State.Status}}' ${containerName} 2>/dev/null || echo "not_found"`);
  return res.stdout.trim();
}
export async function startContainer(server, containerName) {
  return execSudo(server, `docker start ${containerName}`);
}
export async function stopContainer(server, containerName) {
  return execSudo(server, `docker stop ${containerName}`);
}
export async function removeContainer(server, containerName) {
  return execSudo(server, `docker rm -f ${containerName} 2>/dev/null || true`);
}
export async function getContainerLogs(server, containerName, lines = 100) {
  const res = await execSudo(server, `docker logs --tail ${lines} ${containerName} 2>&1`);
  return res.stdout;
}
export async function listAmneziaContainers(server) {
  const res = await exec(server, `docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep amnezia 2>/dev/null || true`);
  if (!res.stdout.trim()) return [];
  return res.stdout.trim().split('\n').map(line => {
    const [name, status, image] = line.split('\t');
    return { name: (name||'').trim(), status: (status||'').trim(), image: (image||'').trim() };
  });
}
export async function ensureDocker(server) {
  const check = await exec(server, 'docker --version 2>/dev/null');
  if (check.code === 0) return true;
  await execSudo(server, 'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker');
  return true;
}

// ─── Сканирование уже установленных протоколов Amnezia ────────────────────────
// Проверяет наличие контейнеров amnezia-awg2, amnezia-xray, amnezia-wireguard
// и считывает их конфигурацию из /opt/amnezia/<proto>/*.key и конфигов
export async function scanExistingProtocols(server) {
  const found = [];

  // Проверяем каждый известный контейнер
  const candidates = [
    { type: 'awg2',      containerName: 'amnezia-awg2',      confDir: '/opt/amnezia/awg' },
    { type: 'wireguard', containerName: 'amnezia-wireguard',  confDir: '/opt/amnezia/wireguard' },
    { type: 'xray',      containerName: 'amnezia-xray',       confDir: '/opt/amnezia/xray' },
  ];

  for (const c of candidates) {
    // execSudo чтобы гарантировать доступ к docker даже без прав группы docker у SSH-пользователя
    const statusRes = await execSudo(server, `docker inspect --format='{{.State.Status}}' ${c.containerName} 2>/dev/null || echo 'not_found'`);
    const status = statusRes.stdout.trim();
    if (status === 'not_found') continue;

    let config = {};
    let port = null;

    if (c.type === 'awg2') {
      // Конфиги хранятся внутри контейнера, не на хосте
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/wireguard_server_public_key.key`);
      const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/awg0.conf`);
      if (!pubKey && !confRaw) continue;
      // Парсим порт из конфига
      const portMatch = confRaw.match(/ListenPort\s*=\s*(\d+)/);
      port = portMatch ? parseInt(portMatch[1]) : null;
      // Парсим параметры обфускации
      const getConf = (key) => { const m = confRaw.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm')); return m ? m[1].trim() : null; };
      config = {
        port,
        subnetIp: '10.8.1.0', subnetCidr: '24',
        serverPubKey: pubKey,
        jc: getConf('Jc'), jmin: getConf('Jmin'), jmax: getConf('Jmax'),
        s1: getConf('S1'), s2: getConf('S2'), s3: getConf('S3'), s4: getConf('S4'),
        h1: getConf('H1'), h2: getConf('H2'), h3: getConf('H3'), h4: getConf('H4'),
        i1: getConf('I1') || '', i2: getConf('I2') || '', i3: getConf('I3') || '',
        i4: getConf('I4') || '', i5: getConf('I5') || '',
      };
    } else if (c.type === 'wireguard') {
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/wireguard_server_public_key.key`);
      const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/wg0.conf`);
      if (!pubKey && !confRaw) continue;
      const portMatch = confRaw.match(/ListenPort\s*=\s*(\d+)/);
      port = portMatch ? parseInt(portMatch[1]) : null;
      config = { port, subnetIp: '10.8.1.0', subnetCidr: '24', serverPubKey: pubKey };
    } else if (c.type === 'xray') {
      let serverJson = null;
      try {
        const confRaw = await readContainerFile(server, c.containerName, `${c.confDir}/server.json`);
        serverJson = JSON.parse(confRaw);
      } catch { continue; }
      const pubKey  = await readContainerFile(server, c.containerName, `${c.confDir}/xray_public.key`);
      const shortId = await readContainerFile(server, c.containerName, `${c.confDir}/xray_short_id.key`);
      const uuid    = await readContainerFile(server, c.containerName, `${c.confDir}/xray_uuid.key`);
      port = serverJson?.inbounds?.[0]?.port || null;
      const sni = serverJson?.inbounds?.[0]?.streamSettings?.realitySettings?.dest?.replace(/:443$/, '') || '';
      config = { port, sni, publicKey: pubKey, shortId, firstUuid: uuid };
    }

    // Читаем clientsTable из контейнера — источник истины по именам клиентов
    let clients = [];
    try {
      const raw = await readContainerFile(server, c.containerName, `${c.confDir}/clientsTable`);
      const table = JSON.parse(raw);
      clients = table.map(e => ({
        clientId: e.clientId,
        name: e.userData?.clientName || `client-${String(e.clientId).slice(0, 8)}`,
      }));
    } catch {}

    found.push({
      type: c.type,
      containerName: c.containerName,
      status,
      port,
      config,
      clients,
    });
  }

  return found;
}

// ─── UI описания ──────────────────────────────────────────────────────────────

export const PROTOCOLS = {
  awg2:      { name: 'AmneziaWG 2.0',     description: 'WireGuard + расширенная обфускация DPI',  icon: '🛡️' },
  xray:      { name: 'Xray VLESS Reality', description: 'VLESS + Reality — имитирует TLS трафик',  icon: '⚡' },
  wireguard: { name: 'WireGuard',          description: 'Классический WireGuard без обфускации',   icon: '🔒' },
};
