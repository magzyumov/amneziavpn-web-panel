// Доменные модели проекта.

export type AuthType = 'password' | 'key';
export type ProtocolType = 'awg2' | 'wireguard' | 'xray';
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
export interface Awg2Config {
  port: number;
  subnetIp: string;
  subnetCidr: string;
  serverPubKey: string;
  jc: number; jmin: number; jmax: number;
  s1: number; s2: number; s3: number; s4: number;
  h1: number; h2: number; h3: number; h4: number;
  i1: number; i2: number; i3: number; i4: number; i5: number;
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

export interface InstallResult {
  containerName: string;
  port: number;
  config: Awg2Config | WireGuardConfig | XrayConfig;
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
