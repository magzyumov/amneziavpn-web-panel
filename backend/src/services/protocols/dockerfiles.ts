// Dockerfile'ы и скрипты, восстановленные реверсом Amnezia Desktop.
// Логика должна совпадать байт-в-байт с эталоном — менять только при необходимости.

export const DOCKERFILES = {

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
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/sysctl.conf && \\
  mkdir -p /etc/security && \\
  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/security/limits.conf

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
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/sysctl.conf && \\\n  mkdir -p /etc/security && \\\n  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/security/limits.conf

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
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/sysctl.conf && \\
  mkdir -p /etc/security && \\
  echo -e " \n\
  * soft nofile 51200 \n\
  * hard nofile 51200 \n\
  " | sed -e 's/^\\s\\+//g' | tee -a /etc/security/limits.conf

ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]
CMD [ "" ]`,
};

export const START_SCRIPTS = {

  awg2: (subnetIp: string, subnetCidr: string, serverIp: string) => `#!/bin/bash

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

  xray: (port: number, serverIp: string) => `#!/bin/bash
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

  wireguard: (subnetIp: string, subnetCidr: string, serverIp: string) => `#!/bin/bash

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

export const CONFIGURE_SCRIPTS = {

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
    "stats": {},
    "api": { "tag": "api", "services": ["StatsService"] },
    "policy": {
        "levels": { "0": { "statsUserUplink": true, "statsUserDownlink": true } },
        "system": { "statsInboundUplink": true, "statsInboundDownlink": true }
    },
    "routing": {
        "rules": [{ "type": "field", "inboundTag": ["api"], "outboundTag": "api" }]
    },
    "inbounds": [
        {
            "tag": "api",
            "port": 10085,
            "listen": "127.0.0.1",
            "protocol": "dokodemo-door",
            "settings": { "address": "127.0.0.1" }
        },
        {
            "tag": "vless-in",
            "port": $XRAY_SERVER_PORT,
            "protocol": "vless",
            "settings": {
                "clients": [{ "id": "$XRAY_CLIENT_ID", "email": "$XRAY_CLIENT_ID", "level": 0, "flow": "xtls-rprx-vision" }],
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
        }
    ],
    "outbounds": [
        { "protocol": "freedom", "tag": "direct" },
        { "protocol": "blackhole", "tag": "api" }
    ]
}
EOF`,
};

export const AWG2_CLIENT_TEMPLATE = `[Interface]
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

export const WG_CLIENT_TEMPLATE = `[Interface]
Address = $WIREGUARD_CLIENT_IP/32
DNS = $PRIMARY_DNS, $SECONDARY_DNS
PrivateKey = $WIREGUARD_CLIENT_PRIVATE_KEY

[Peer]
PublicKey = $WIREGUARD_SERVER_PUBLIC_KEY
PresharedKey = $WIREGUARD_PSK
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $SERVER_IP_ADDRESS:$WIREGUARD_SERVER_PORT
PersistentKeepalive = 25`;

export const XRAY_CLIENT_TEMPLATE = `{
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

export const AWG2_CLIENT_JSON_TEMPLATE = `{
    "container": "amnezia-awg2",
    "host": "$SERVER_IP_ADDRESS",
    "port": "$AWG_SERVER_PORT",
    "type": "awg2",
    "client_pub_key": "$WIREGUARD_CLIENT_PUBLIC_KEY",
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

export const WG_CLIENT_JSON_TEMPLATE = `{
    "container": "amnezia-wireguard",
    "host": "$SERVER_IP_ADDRESS",
    "port": "$WIREGUARD_SERVER_PORT",
    "type": "wireguard",
    "client_pub_key": "$WIREGUARD_CLIENT_PUBLIC_KEY",
    "config": {
        "address": "$WIREGUARD_CLIENT_IP/32",
        "dns": "$PRIMARY_DNS, $SECONDARY_DNS",
        "private_key": "$WIREGUARD_CLIENT_PRIVATE_KEY",
        "public_key": "$WIREGUARD_SERVER_PUBLIC_KEY",
        "psk": "$WIREGUARD_PSK"
    }
}`;
