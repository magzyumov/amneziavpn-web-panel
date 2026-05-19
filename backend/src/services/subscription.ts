/**
 * subscription.js
 *
 * Генерирует Clash YAML подписки для FLClash.
 * Шаблон хранится в БД (settings.clash_template).
 * Для каждого Xray клиента создаётся подписка с уникальным slug.
 * URL подписки: GET /sub/:slug — отдаёт готовый YAML.
 */

import crypto from 'crypto';
import { query, queryOne, run } from './db.js';
import type { Subscription } from '../types.js';

// ─── Дефолтный шаблон (можно редактировать в UI) ────────────────────────────

export const DEFAULT_TEMPLATE = `proxy-groups:
  - name: "🚫 Недоступные сайты"
    type: select
    proxies:
      - PROXY_NAME_PLACEHOLDER
      - DIRECT
  - name: "➤ Telegram"
    type: select
    proxies:
      - "🚫 Недоступные сайты"
      - DIRECT
  - name: "➤ Whatsapp"
    type: select
    proxies:
      - "🚫 Недоступные сайты"
      - DIRECT
  - name: "🟠 Cloudflare"
    type: select
    proxies:
      - DIRECT
      - "🚫 Недоступные сайты"
  - name: "⚪🔵🔴 RU сайты"
    type: select
    proxies:
      - DIRECT
  - name: "🌍 Остальные сайты"
    type: select
    proxies:
      - DIRECT
      - "🚫 Недоступные сайты"

# PROXIES_PLACEHOLDER

mixed-port: 7890
allow-lan: true
tcp-concurrent: true
find-process-mode: always
mode: rule
log-level: info
ipv6: false
keep-alive-interval: 30
unified-delay: false

sniffer:
  enable: true
  force-dns-mapping: true
  parse-pure-ip: true
  override-destination: false
  sniff:
    HTTP:
      ports:
        - 80
        - 8080-8880
      override-destination: true
    TLS:
      ports:
        - 443
        - 8443

dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-filter:
    - "*.alfabank.ru"
    - "*.local"
  default-nameserver:
    - 1.1.1.1
    - 8.8.8.8
  proxy-server-nameserver:
    - tls://1.1.1.1
    - https://8.8.8.8/dns-query
  nameserver:
    - tls://94.140.14.14
    - tls://94.140.15.15
  direct-nameserver:
    - 77.88.8.8
    - 8.8.8.8
  nameserver-policy:
    "*.alfabank.ru":
      - 10.226.0.5
    "rule-set:geosite-ru":
      - 77.88.8.8
      - 8.8.8.8
    "raw.githubusercontent.com,cdn.jsdelivr.net,github.com":
      - 77.88.8.8
      - 8.8.8.8

rule-providers:
  ru-inline-banned:
    type: inline
    payload:
      - DOMAIN-SUFFIX,pstmn.io
      - DOMAIN-SUFFIX,habr.com
      - DOMAIN-SUFFIX,seasonvar.ru
      - DOMAIN-SUFFIX,lib.social
      - DOMAIN-SUFFIX,kemono.su
      - DOMAIN-SUFFIX,jut.su
      - DOMAIN-SUFFIX,kara.su
      - DOMAIN-SUFFIX,theins.ru
      - DOMAIN-SUFFIX,tvrain.ru
      - DOMAIN-SUFFIX,echo.msk.ru
      - DOMAIN-SUFFIX,the-village.ru
      - DOMAIN-SUFFIX,snob.ru
      - DOMAIN-SUFFIX,novayagazeta.ru
      - DOMAIN-SUFFIX,moscowtimes.ru
      - DOMAIN-KEYWORD,animego
      - DOMAIN-KEYWORD,yummyanime
      - DOMAIN-KEYWORD,animeportal
      - DOMAIN-KEYWORD,animedub
      - DOMAIN-KEYWORD,anidub
      - DOMAIN-KEYWORD,animelib
      - DOMAIN-KEYWORD,ikianime
      - DOMAIN-KEYWORD,anilibria
    behavior: classical
  ru-inline:
    type: inline
    payload:
      - DOMAIN-SUFFIX,2ip.ru
      - DOMAIN-SUFFIX,yastatic.net
      - DOMAIN-SUFFIX,yandex.net
      - DOMAIN-SUFFIX,yandex.kz
      - DOMAIN-SUFFIX,yandex.com
      - DOMAIN-SUFFIX,yadi.sk
      - DOMAIN-SUFFIX,mycdn.me
      - DOMAIN-SUFFIX,jivosite.com
      - DOMAIN-SUFFIX,vk.com
      - DOMAIN-SUFFIX,avira.com
      - DOMAIN-SUFFIX,.ru
      - DOMAIN-SUFFIX,.su
      - DOMAIN-SUFFIX,.by
      - DOMAIN-SUFFIX,.ru.com
      - DOMAIN-SUFFIX,.ru.net
      - DOMAIN-SUFFIX,kudago.com
      - DOMAIN-SUFFIX,kinescope.io
      - DOMAIN-SUFFIX,remanga.org
      - DOMAIN-KEYWORD,avito
      - DOMAIN-KEYWORD,2gis
      - DOMAIN-KEYWORD,diginetica
      - DOMAIN-KEYWORD,kinescopecdn
      - DOMAIN-KEYWORD,researchgate
      - DOMAIN-KEYWORD,kaspersky
      - DOMAIN-KEYWORD,stepik
      - DOMAIN-KEYWORD,likee
      - DOMAIN-KEYWORD,pikabu
      - DOMAIN-KEYWORD,okko
      - DOMAIN-KEYWORD,wink
      - DOMAIN-KEYWORD,kion
      - DOMAIN-KEYWORD,roblox
      - DOMAIN-KEYWORD,ozon
      - DOMAIN-KEYWORD,wildberries
      - DOMAIN-KEYWORD,aliexpress
    behavior: classical
  geosite-ru:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/category-ru.mrs
    path: ./rule-sets/geosite-ru.mrs
    interval: 86400
  yandex:
    type: http
    behavior: domain
    format: yaml
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/yandex.yaml
    path: ./rule-sets/yandex.yaml
    interval: 86400
  mailru:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/mailru.mrs
    path: ./rule-sets/mailru.mrs
    interval: 86400
  drweb:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/drweb.mrs
    path: ./rule-sets/drweb.mrs
    interval: 86400
  geoip-ru:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geoip/ru.mrs
    path: ./rule-sets/geoip-ru.mrs
    interval: 86400
  geoip-by:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geoip/by.mrs
    path: ./rule-sets/geoip-by.mrs
    interval: 86400
  geosite-private:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/private.mrs
    path: ./rule-sets/geosite-private.mrs
    interval: 86400
  geoip-private:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geoip/private.mrs
    path: ./rule-sets/geoip-private.mrs
    interval: 86400
  discord_domains:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/discord.mrs
    path: ./rule-sets/discord_domains.mrs
    interval: 86400
  youtube:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/youtube.mrs
    path: ./rule-sets/youtube.mrs
    interval: 86400
  telegram-ips:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geoip/telegram.mrs
    path: ./rule-sets/telegram-ips.mrs
    interval: 86400
  telegram-domains:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/telegram.mrs
    path: ./rule-sets/telegram-domains.mrs
    interval: 86400
  whatsapp-domains:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/whatsapp.mrs
    path: ./rule-sets/whatsapp-domains.mrs
    interval: 86400
  oisd_big:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/legiz-ru/mihomo-rule-sets/raw/main/oisd/big.mrs
    path: ./rule-sets/oisd_big.mrs
    interval: 86400
  cloudflare-ips:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geoip/cloudflare.mrs
    path: ./rule-sets/cloudflare-ips.mrs
    interval: 86400
  cloudflare-domains:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/cloudflare.mrs
    path: ./rule-sets/cloudflare-domains.mrs
    interval: 86400
  ru-outside:
    type: http
    behavior: classical
    format: text
    url: https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Russia/outside-clashx.lst
    path: ./rule-sets/ru-outside.lst
    interval: 86400
  ru-inside:
    type: http
    behavior: classical
    format: text
    url: https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-clashx.lst
    path: ./rule-sets/ru-inside.lst
    interval: 86400
  refilter_domains:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/legiz-ru/mihomo-rule-sets/raw/main/re-filter/domain-rule.mrs
    path: ./rule-sets/refilter.mrs
    interval: 86400
  ai:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/category-ai-!cn.mrs
    path: ./rule-sets/ai.mrs
    interval: 86400
  speedtest-net:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/speedtest.mrs
    path: ./rule-sets/speedtest-net.mrs
    interval: 86400
  category-porn:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo/geosite/category-porn.mrs
    path: ./rule-sets/category-porn.mrs
    interval: 86400
  google-deepmind:
    type: http
    behavior: domain
    format: mrs
    url: https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/google-gemini.mrs
    path: ./rule-sets/google-deepmind.mrs
    interval: 86400
  quic:
    type: inline
    behavior: classical
    payload:
      - AND,((NETWORK,udp),(DST-PORT,443))

rules:
  - DOMAIN-SUFFIX,alfabank.ru,DIRECT,no-resolve
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - RULE-SET,geoip-private,DIRECT,no-resolve
  - RULE-SET,geosite-private,DIRECT
  - RULE-SET,oisd_big,REJECT
  - OR,((DOMAIN-SUFFIX,ads.twitch.tv),(DOMAIN-SUFFIX,playlist.ttvnw.net)),DIRECT
  - RULE-SET,quic,REJECT
  - DOMAIN,ipwho.is,🚫 Недоступные сайты
  - DOMAIN,api.myip.com,🚫 Недоступные сайты
  - DOMAIN,ipapi.co,🚫 Недоступные сайты
  - DOMAIN,2ip.io,🚫 Недоступные сайты
  - DOMAIN,ipinfo.io,🚫 Недоступные сайты
  - RULE-SET,youtube,🚫 Недоступные сайты
  - RULE-SET,telegram-ips,➤ Telegram
  - RULE-SET,telegram-domains,➤ Telegram
  - RULE-SET,whatsapp-domains,➤ Whatsapp
  - RULE-SET,discord_domains,🚫 Недоступные сайты
  - RULE-SET,ru-inside,🚫 Недоступные сайты
  - RULE-SET,refilter_domains,🚫 Недоступные сайты
  - RULE-SET,ru-inline-banned,🚫 Недоступные сайты
  - RULE-SET,category-porn,🚫 Недоступные сайты
  - RULE-SET,ai,🚫 Недоступные сайты
  - RULE-SET,google-deepmind,🚫 Недоступные сайты
  - RULE-SET,speedtest-net,🚫 Недоступные сайты
  - RULE-SET,cloudflare-ips,🟠 Cloudflare
  - RULE-SET,cloudflare-domains,🟠 Cloudflare
  - RULE-SET,ru-inline,⚪🔵🔴 RU сайты
  - RULE-SET,ru-outside,⚪🔵🔴 RU сайты
  - RULE-SET,yandex,⚪🔵🔴 RU сайты
  - RULE-SET,mailru,⚪🔵🔴 RU сайты
  - RULE-SET,drweb,⚪🔵🔴 RU сайты
  - RULE-SET,geosite-ru,⚪🔵🔴 RU сайты
  - RULE-SET,geoip-ru,⚪🔵🔴 RU сайты,no-resolve
  - RULE-SET,geoip-by,⚪🔵🔴 RU сайты,no-resolve
  - MATCH,🌍 Остальные сайты
`;

// ─── Парсим VLESS URI → Clash proxy entry ───────────────────────────────────

interface ClashProxy {
  name: string;
  type: 'vless';
  server: string;
  port: number;
  uuid: string;
  network: string;
  tls: true;
  'reality-opts': { 'public-key': string; 'short-id': string };
  'client-fingerprint': string;
  servername: string;
  flow: string;
  'skip-cert-verify': false;
}

function vlessUriToClashProxy(vlessUrl: string, name: string): ClashProxy | null {
  // vless://uuid@host:port?type=tcp&security=reality&pbk=...&fp=...&sni=...&sid=...&flow=...#name
  try {
    const url = new URL(vlessUrl);
    const params = url.searchParams;

    return {
      name,
      type: 'vless',
      server: url.hostname,
      port: parseInt(url.port),
      uuid: url.username,
      network: params.get('type') || 'tcp',
      tls: true,
      'reality-opts': {
        'public-key': params.get('pbk') || '',
        'short-id': params.get('sid') || '',
      },
      'client-fingerprint': params.get('fp') || 'chrome',
      servername: params.get('sni') || '',
      flow: params.get('flow') || 'xtls-rprx-vision',
      'skip-cert-verify': false,
    };
  } catch {
    return null;
  }
}

// ─── Генерируем YAML из шаблона + VLESS URI ─────────────────────────────────

export function generateYaml(template: string, vlessUrl: string, clientName: string): string {
  const proxyName = clientName.replace(/[^a-zA-Z0-9_\- ]/g, '_');
  const proxy = vlessUriToClashProxy(vlessUrl, proxyName);
  if (!proxy) throw new Error('Invalid VLESS URL');

  // Сериализуем proxy в YAML вручную (без зависимости от yaml-библиотеки)
  const proxyYaml = [
    `proxies:`,
    `  - name: "${proxy.name}"`,
    `    type: ${proxy.type}`,
    `    server: ${proxy.server}`,
    `    port: ${proxy.port}`,
    `    uuid: ${proxy.uuid}`,
    `    network: ${proxy.network}`,
    `    tls: ${proxy.tls}`,
    `    reality-opts:`,
    `      public-key: ${proxy['reality-opts']['public-key']}`,
    `      short-id: ${proxy['reality-opts']['short-id']}`,
    `    client-fingerprint: ${proxy['client-fingerprint']}`,
    `    servername: ${proxy.servername}`,
    `    flow: ${proxy.flow}`,
    `    skip-cert-verify: false`,
  ].join('\n');

  // Подставляем в шаблон
  let yaml = template
    .replace('# PROXIES_PLACEHOLDER', proxyYaml)
    .replaceAll('PROXY_NAME_PLACEHOLDER', `"${proxy.name}"`);

  return yaml;
}

// ─── CRUD подписок ──────────────────────────────────────────────────────────

interface SettingRow { value: string }

export function getTemplate(): string {
  const row = queryOne<SettingRow>("SELECT value FROM settings WHERE key = 'clash_template'");
  return row ? row.value : DEFAULT_TEMPLATE;
}

export function saveTemplate(template: string): void {
  const existing = queryOne("SELECT key FROM settings WHERE key = 'clash_template'");
  if (existing) {
    run("UPDATE settings SET value = ? WHERE key = 'clash_template'", [template]);
  } else {
    run("INSERT INTO settings (key, value) VALUES ('clash_template', ?)", [template]);
  }
}

export function getVpsHost(): string {
  const row = queryOne<SettingRow>("SELECT value FROM settings WHERE key = 'vps_host'");
  return row ? row.value : '';
}

export function saveVpsHost(host: string): void {
  const existing = queryOne("SELECT key FROM settings WHERE key = 'vps_host'");
  if (existing) {
    run("UPDATE settings SET value = ? WHERE key = 'vps_host'", [host]);
  } else {
    run("INSERT INTO settings (key, value) VALUES ('vps_host', ?)", [host]);
  }
}

interface CreateSubscriptionArgs {
  clientId: string;
  clientName: string;
  serverHost: string;
  vlessUrl: string;
}

export function createSubscription({ clientId, clientName, serverHost, vlessUrl }: CreateSubscriptionArgs): { slug: string; yaml: string } {
  const slug = generateSlug(clientName);
  const template = getTemplate();
  const yaml = generateYaml(template, vlessUrl, clientName);

  run(
    `INSERT OR REPLACE INTO subscriptions (id, client_id, client_name, server_host, slug, yaml_content, vless_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, clientId, clientName, serverHost, slug, yaml, vlessUrl]
  );

  return { slug, yaml };
}

export function regenerateAllSubscriptions(): number {
  const template = getTemplate();
  const subs = query<Subscription>('SELECT * FROM subscriptions');
  let updated = 0;
  for (const sub of subs) {
    try {
      const yaml = generateYaml(template, sub.vless_url, sub.client_name);
      run('UPDATE subscriptions SET yaml_content = ? WHERE id = ?', [yaml, sub.id]);
      updated++;
    } catch { /* ignore */ }
  }
  return updated;
}

export function getSubscriptionBySlug(slug: string): Subscription | null {
  return queryOne<Subscription>('SELECT * FROM subscriptions WHERE slug = ?', [slug]);
}

export function listSubscriptions(): Array<Pick<Subscription, 'id' | 'client_name' | 'server_host' | 'slug' | 'created_at'>> {
  return query('SELECT id, client_name, server_host, slug, created_at FROM subscriptions ORDER BY created_at DESC');
}

export function deleteSubscription(clientId: string): void {
  run('DELETE FROM subscriptions WHERE client_id = ?', [clientId]);
}

// ─── Генерация уникального slug ─────────────────────────────────────────────

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'client';

  // 24 байта = 192 бита энтропии в base64url. Slug не угадывается перебором.
  const rand = crypto.randomBytes(24).toString('base64url');
  return `${base}-${rand}`;
}
