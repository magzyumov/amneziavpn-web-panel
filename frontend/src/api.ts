import axios, { type InternalAxiosRequestConfig } from 'axios';

const CSRF_COOKIE = 'panel_csrf';

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

const api = axios.create({ baseURL: '/api', withCredentials: true });

api.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
  // Double-submit CSRF: подкладываем токен из cookie в заголовок для не-GET запросов.
  const method = (cfg.method || 'get').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf && cfg.headers) cfg.headers['X-CSRF-Token'] = csrf;
  }
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      if (window.location.pathname !== '/login' && window.location.pathname !== '/setup') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'key';
  created_at?: string;
}

// Расхождение установленного на сервере с тем, что панель поставила бы сейчас.
export interface ProtocolDrift {
  image: boolean;    // образ собран из другого Dockerfile
  runArgs: boolean;  // контейнер запущен с другими аргументами docker run
}

export interface HealthResponse {
  statuses: Record<string, string>;
  drift: Record<string, ProtocolDrift>;
}

export interface ProtocolRecord {
  id: string;
  server_id: string;
  type: 'awg2' | 'wireguard' | 'xray' | 'telemt';
  name: string | null;
  container_name: string;
  port: number;
  config: Record<string, unknown>;
  status: string;
}

// Лимиты клиента. expires_at — unix sec (null = бессрочно); daily_limit_bytes
// 0 = без лимита; suspended_at != null — пир снят с сервера до новых суток.
export interface ClientLimits {
  expires_at: number | null;
  daily_limit_bytes: number;
  suspended_at: number | null;
  used_today: number;
}

export interface ClientRecord extends ClientLimits {
  id: string;
  name: string;
  created_at: string;
  has_config: number;
  /** Владелец клиента. Приходит только админу (список клиентов протокола). */
  owner_username?: string | null;
}

export type UserRole = 'admin' | 'user';

// Свой клиент с точки зрения обычного пользователя: сервер и протокол он видит
// только как подписи — ни хоста, ни контейнера, ни портов ему не отдают.
export interface MyClientRecord extends ClientRecord {
  protocol_id: string;
  protocol_type: ProtocolRecord['type'];
  protocol_config: Record<string, unknown>;
  server_name: string;
  /** Трафик за последние 7 дней. */
  week_rx: number;
  week_tx: number;
  last_handshake: number | null;
  online: boolean;
}

// Протокол, на котором текущему пользователю разрешено завести клиента.
export interface AvailableProtocol {
  id: string;
  type: ProtocolRecord['type'];
  config: Record<string, unknown>;
  status: string;
  server_id: string;
  server_name: string;
}

export interface PanelUser {
  id: string;
  username: string;
  role: UserRole;
  client_limit: number;
  /** Лимиты, которые получают клиенты этого пользователя. 0 = без ограничения. */
  default_expiry_days: number;
  default_daily_limit_mb: number;
  clients_count: number;
  created_at: string;
  protocolIds: string[];
}

export interface CurrentUser {
  username: string;
  role: UserRole;
  clientLimit: number;
  /** Лимиты, которые получат клиенты, создаваемые этим пользователем. 0 = без ограничения. */
  defaultExpiryDays: number;
  defaultDailyLimitMb: number;
}

export const authApi = {
  status: () => api.get<{ configured: boolean }>('/auth/status'),
  setup: (data: { username: string; password: string }) => api.post('/auth/setup', data),
  login: (data: { username: string; password: string }) => api.post<{ username: string; role: UserRole }>('/auth/login', data),
  logout: () => api.post('/auth/logout'),
  me: () => api.get<CurrentUser>('/auth/me'),
};

export interface UserPayload {
  username?: string;
  password?: string;
  role?: UserRole;
  clientLimit?: number;
  defaultExpiryDays?: number;
  defaultDailyLimitMb?: number;
  protocolIds?: string[];
}

export interface DayBucket { day: string; rx: number; tx: number }

// Сводка главной страницы. Считается целиком из базы панели — SSH при открытии
// дашборда не происходит, поэтому он не зависит от доступности VPS.
// Метрики хоста и статус DNS приходят из ручного опроса (кнопка «Опросить
// серверы») и живут в базе. null = замера ещё не было.
export interface ServerSummary {
  id: string; name: string; host: string;
  protocols: number; running: number;
  /** unix sec последнего успешного опроса статистики; null — ни разу. */
  lastPollAt: number | null;
  /** Протоколы числятся запущенными, но воркер до них давно не достучался. */
  stale: boolean;
  dnsInstalled: boolean | null;
  probedAt: number | null;
  probeError: string | null;
  uptimeSec: number | null;
  load1: number | null;
  memTotalMb: number | null;
  memUsedMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
}

export interface DashboardSummary {
  servers: ServerSummary[];
  protocols: {
    total: number; running: number;
    byType: Array<{ type: ProtocolRecord['type']; count: number; clients: number }>;
  };
  users: { total: number; admins: number; regular: number };
  clients: {
    total: number; online: number; suspended: number;
    withLimits: number; expiringSoon: number; orphaned: number;
    /** Уникальных клиентов с рукопожатием за текущие сутки. */
    activeToday: number;
  };
  issues: {
    drifted: Array<{
      id: string; serverId: string; serverName: string;
      type: ProtocolRecord['type']; image: boolean; runArgs: boolean;
    }>;
    silent: Array<{
      id: string; serverId: string; serverName: string;
      type: ProtocolRecord['type']; clients: number;
    }>;
  };
  storage: {
    dbBytes: number;
    statsRows: number;
    oldestSnapshotAt: number | null;
    retentionDays: number;
  };
  traffic: {
    today: { rx: number; tx: number };
    week: { rx: number; tx: number };
    daily: DayBucket[];
    topClients: Array<{
      id: string; name: string; type: ProtocolRecord['type'];
      owner: string | null; rx: number; tx: number;
    }>;
  };
  subscriptions: number;
}

export type AuditStatus = 'ok' | 'denied' | 'failed';

// Запись журнала действий. Имена пользователя и объекта — снимки на момент
// действия, поэтому читаются и после их удаления.
export interface AuditRecord {
  id: number;
  ts: number;
  user_id: string | null;
  username: string;
  role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  status: AuditStatus;
  http_status: number | null;
}

export interface AuditResponse {
  rows: AuditRecord[];
  total: number;
  retentionDays: number;
  usernames: string[];
  actions: string[];
}

export interface AuditQuery {
  username?: string;
  action?: string;
  status?: AuditStatus;
  since?: number;
  limit?: number;
  offset?: number;
}

export const auditApi = {
  list: (params: AuditQuery = {}) => api.get<AuditResponse>('/audit', { params }),
};

export const dashboardApi = {
  summary: () => api.get<DashboardSummary>('/dashboard'),
  // Единственное действие дашборда, которое ходит по SSH — и только по кнопке.
  probe: () => api.post<{ probed: number; summary: DashboardSummary }>('/dashboard/probe'),
};

export const usersApi = {
  list: () => api.get<PanelUser[]>('/users'),
  create: (data: UserPayload & { username: string; password: string }) => api.post<PanelUser>('/users', data),
  update: (id: string, data: UserPayload) => api.put<PanelUser>(`/users/${id}`, data),
  delete: (id: string) => api.delete<{ ok: true; orphanedClients: number }>(`/users/${id}`),
};

export const serversApi = {
  list: () => api.get<ServerRecord[]>('/servers'),
  create: (data: Partial<ServerRecord> & { password?: string; private_key?: string }) => api.post('/servers', data),
  delete: (id: string) => api.delete(`/servers/${id}`),
  test: (id: string) => api.post(`/servers/${id}/test`),
  ensureDocker: (id: string) => api.post(`/servers/${id}/ensure-docker`),
  containers: (id: string) => api.get(`/servers/${id}/containers`),
  update: (id: string, data: Partial<ServerRecord> & { password?: string; private_key?: string }) => api.put(`/servers/${id}`, data),
  scanProtocols: (id: string) => api.post(`/servers/${id}/scan-protocols`),
  importProtocol: (id: string, data: any) => api.post(`/servers/${id}/import-protocol`, data),
  dnsStatus: (id: string) => api.get<{ installed: boolean }>(`/servers/${id}/dns`),
  installDns: (id: string) => api.post(`/servers/${id}/dns`),
  removeDns: (id: string) => api.delete(`/servers/${id}/dns`),
};

export const protocolsApi = {
  list: () => api.get('/protocols'),
  byServer: (serverId: string) => api.get<ProtocolRecord[]>(`/protocols/server/${serverId}`),
  install: (serverId: string, data: { type: string; options?: any }) => api.post(`/protocols/server/${serverId}`, data),
  delete: (id: string) => api.delete(`/protocols/${id}`),
  start: (id: string) => api.post(`/protocols/${id}/start`),
  stop: (id: string) => api.post(`/protocols/${id}/stop`),
  status: (id: string) => api.get(`/protocols/${id}/status`),
  health: (serverId: string) => api.get<HealthResponse>(`/protocols/server/${serverId}/health`),
  logs: (id: string, lines: number) => api.get<{ logs: string }>(`/protocols/${id}/logs`, { params: { lines } }),
  statsStatus: (id: string) => api.get<{ statsEnabled: boolean }>(`/protocols/${id}/stats-status`),
  enableStats: (id: string) => api.post(`/protocols/${id}/enable-stats`),
};

export type StatsRange = '1h' | '24h' | '7d' | '30d';
export interface ClientStatsResponse {
  online: boolean;
  lastHandshake: number | null;
  totalRx: number;
  totalTx: number;
  series: Array<{ ts: number; rxRate: number; txRate: number }>;
}

export const clientsApi = {
  byProtocol: (protocolId: string) => api.get<ClientRecord[]>(`/clients/protocol/${protocolId}`),
  mine: () => api.get<MyClientRecord[]>('/clients/mine'),
  availableProtocols: () => api.get<AvailableProtocol[]>('/clients/available-protocols'),
  create: (data: { protocolId: string; name: string; expiresInDays?: number; dailyLimitMb?: number }) =>
    api.post('/clients', data),
  delete: (id: string) => api.delete(`/clients/${id}`),
  // Только для админа: срок и суточный лимит существующего клиента.
  setLimits: (id: string, data: { expiresInDays?: number; dailyLimitMb?: number }) =>
    api.put<(ClientLimits & { id: string; name: string }) | { deleted: true }>(`/clients/${id}/limits`, data),
  qr: (id: string) => api.get(`/clients/${id}/qr`),
  configText: (id: string) => api.get<{ config: string | null; vpnUri: string | null; name: string }>(`/clients/${id}/config-text`),
  configDownloadUrl: (id: string) => `/api/clients/${id}/config`,
  configAmneziaUrl: (id: string) => `/api/clients/${id}/config-amnezia`,
  subscription: (id: string) => api.get<{ slug: string | null }>(`/clients/${id}/subscription`),
  stats: (id: string, range: StatsRange = '24h') =>
    api.get<ClientStatsResponse>(`/clients/${id}/stats`, { params: { range } }),
};

export async function downloadWithAuth(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

export const subscriptionsApi = {
  list: () => api.get('/subscriptions'),
  delete: (id: string) => api.delete(`/subscriptions/${id}`),
  getTemplate: () => api.get<{ template: string; default: string }>('/subscriptions/template'),
  saveTemplate: (template: string) => api.post('/subscriptions/template', { template }),
  resetTemplate: () => api.post('/subscriptions/template/reset'),
  regenerate: () => api.post('/subscriptions/regenerate'),
  getSettings: () => api.get<{ vpsHost: string }>('/subscriptions/settings'),
  saveSettings: (data: { vpsHost?: string }) => api.post('/subscriptions/settings', data),
  subUrl: (slug: string): string => {
    const port = window.location.port || '80';
    return `${window.location.protocol}//${window.location.hostname}:${port}/sub/${slug}`;
  },
};
