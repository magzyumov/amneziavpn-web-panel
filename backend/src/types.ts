// Доменные модели проекта.

export type AuthType = 'password' | 'key';
export type UserRole = 'admin' | 'user';
export type ProtocolType = 'awg2' | 'wireguard' | 'xray' | 'telemt';
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
  peer_id?: string | null;
  /** Владелец. NULL = «ничей», доступен только админам (legacy и клиенты удалённых юзеров). */
  user_id?: string | null;
  /** Unix sec. По истечении клиент удаляется вместе с peer'ом на сервере. NULL = бессрочно. */
  expires_at?: number | null;
  /** Суточный лимит трафика в байтах (rx+tx). 0 = без лимита. */
  daily_limit_bytes?: number;
  /** Unix sec приостановки по суточному лимиту. NULL = активен. */
  suspended_at?: number | null;
  created_at?: string;
}

export interface AppUser {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  /** Сколько клиентов юзер может завести себе сам. 0 = без ограничения. */
  client_limit: number;
  /** Срок действия клиентов, которые заводит этот пользователь. 0 = бессрочно. */
  default_expiry_days: number;
  /** Суточный лимит трафика его клиентов, МБ. 0 = без лимита. */
  default_daily_limit_mb: number;
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
// h1-h4 и i1-i5 — это магические маркеры пакетов AWG (одиночные целые;
// userspace amneziawg-go не принимает range "min-max"). installAWG2 кладёт их
// строкой (число от пользователя или сгенерированный randInt);
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
  protocolVersion: string;
  jc: number | string; jmin: number | string; jmax: number | string;
  s1: number | string; s2: number | string; s3: number | string; s4: number | string;
  h1: string; h2: string; h3: string; h4: string;
  i1: string; i2: string; i3: string; i4: string; i5: string;
  // AWG 3.0 (amneziawg-go 3.x). Пустая строка / undefined = параметр не задан,
  // строка в конфиг не пишется. headerProtectionKey — server-side: обязан совпадать
  // на сервере и клиенте. Остальные — client-side, тип "uint32,range".
  headerProtectionKey?: string;
  contentPaddingAddition?: string;
  rekeyAfterTime?: string;
  rekeyTimeout?: string;
  rejectAfterTime?: string;
  keepaliveTimeout?: string;
  maxHandshakeAttempts?: string;
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
  // Транспорт: 'tcp' (raw) или 'xhttp' (SplitHTTP, Vision там неприменим).
  // Старые конфиги без поля трактуем как 'tcp'.
  transport?: 'tcp' | 'xhttp';
  xhttpHost?: string;
  xhttpPath?: string;
  xhttpMode?: string;
  // Слой безопасности. Отсутствие поля = 'reality' (так ставили до появления выбора).
  // 'none' — VLESS без TLS: трафик не шифруется, но и SNI, по которому работают
  // фильтры, в пакетах не появляется.
  security?: 'reality' | 'none';
  // uTLS-отпечаток клиента; имеет смысл только при security=reality.
  fingerprint?: string;
  // '' или 'xtls-rprx-vision'. Отсутствие поля = vision (прежнее поведение).
  flow?: string;
}

// Telegram MTProto-прокси (telemt). Это не VPN: проксирует только трафик
// Telegram. На уровне протокола храним порт и FakeTLS-домен; каждый клиент =
// отдельный secret, из которого строится tg://proxy ссылка.
export interface TelemtConfig {
  port: number;
  tlsDomain: string; // Telemt всегда работает в FakeTLS-режиме
}

export interface InstallResult {
  containerName: string;
  port: number;
  config: Awg2Config | WireGuardConfig | XrayConfig | TelemtConfig;
}

export interface AddClientResult {
  config: string;
  configJson?: string;
  type: ProtocolType;
}

// JWT payload. Роль сюда СПЕЦИАЛЬНО не кладём: токен живёт 7 дней, и зашитая
// в него роль означала бы, что разжалование юзера вступает в силу через неделю.
// authMiddleware дочитывает актуальные права из БД на каждом запросе.
export interface AuthPayload {
  id: string;
  username: string;
}

// То, что authMiddleware кладёт в req.user: payload + свежие права из БД.
export interface AuthUser extends AuthPayload {
  role: UserRole;
  clientLimit: number;
}
