/**
 * subscription.ts
 *
 * Генерирует Clash YAML подписки для FLClash.
 * Шаблон хранится в БД (settings.clash_template).
 * Для каждого Xray клиента создаётся подписка с уникальным slug.
 * URL подписки: GET /sub/:slug — отдаёт готовый YAML.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne, run } from './db.js';
import type { Subscription } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Дефолтный шаблон ───────────────────────────────────────────────────────
// Загружается из templates/clash.yaml при старте; редактируемая копия лежит
// в settings.clash_template (см. getTemplate/saveTemplate ниже).
export const DEFAULT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'clash.yaml'),
  'utf8',
);

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
