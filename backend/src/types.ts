// Доменные модели проекта.

export type AuthType = 'password' | 'key';
export type ProtocolType = 'awg2' | 'wireguard' | 'xray' | 'mtproxy' | 'telemt';
export type ContainerStatus = 'running' | 'exited' | 'restarting' | 'paused' | 'dead' | 'created' | 'not_found';

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  password?: string | null;
  private_key?: string | null;
  created_at?: string;
}

export interface Protocol {
  id: string;
  server_id: string;
  type: ProtocolType;
  name: string | null;
  container_name: string;
  port: number;
  config: string; // JSON-string в БД, объект — после parse
  status: string;
  installed_at?: string;
}

export interface ParsedProtocol<C = Record<string, unknown>> extends Omit<Protocol, 'config'> {
  config: C;
}

export interface Client {
  id: string;
  protocol_id: string;
  server_id: string;
  name: string;
  config: string | null;
  created_at?: string;
}

export interface AppUser {
  id: string;
  username: string;
  password_hash: string;
  created_at?: string;
}

export interface Subscription {
  id: string;
  client_id: string;
  client_name: string;
  server_host: string;
  slug: string;
  yaml_content: string | null;
  vless_url: string;
  created_at?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Конфиги протоколов (то, что хранится в protocols.config после JSON.parse).
//
// h1-h4 и i1-i5 — это магические маркеры пакетов AWG. installAWG2 кладёт их
// строкой (либо число от пользователя, либо range "min-max" от randRange);
// scanExistingProtocols читает их из awg0.conf тоже строкой. Поэтому в типе
// они всегда string, не number.
//
// jc/jmin/jmax/s1-s4 — числовые junk-параметры. installAWG2 кладёт число
// (randInt при default'е или валидированный shInt от пользователя), но
// scanExistingProtocols читает их строкой из конфига — отсюда number | string.
export interface Awg2Config {
  port: number;
  subnetIp: string;
  subnetCidr: string;
  serverPubKey: string;
  jc: number | string; jmin: number | string; jmax: number | string;
  s1: number | string; s2: number | string; s3: number | string; s4: number | string;
  h1: string; h2: string; h3: string; h4: string;
  i1: string; i2: string; i3: string; i4: string; i5: string;
}

export interface WireGuardConfig {
  port: number;
  subnetIp: string;
  subnetCidr: string;
  serverPubKey: string;
}

export interface XrayConfig {
  port: number;
  sni: string;
  publicKey: string;
  shortId: string;
  firstUuid: string;
}

// Telegram MTProto-прокси (mtproxy / telemt). Это не VPN: проксируют только
// трафик Telegram. На уровне протокола храним порт и FakeTLS-домен; каждый
// клиент = отдельный secret, из которого строится tg://proxy ссылка.
export interface MtproxyConfig {
  port: number;
  tlsDomain: string; // непусто = FakeTLS (ee-secret), пусто = secure mode (dd-secret)
}

export interface TelemtConfig {
  port: number;
  tlsDomain: string; // Telemt всегда работает в FakeTLS-режиме
}

export interface InstallResult {
  containerName: string;
  port: number;
  config: Awg2Config | WireGuardConfig | XrayConfig | MtproxyConfig | TelemtConfig;
}

export interface AddClientResult {
  config: string;
  configJson?: string;
  type: ProtocolType;
}

// JWT payload
export interface AuthPayload {
  id: string;
  username: string;
}
