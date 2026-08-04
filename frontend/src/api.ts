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

export interface ClientRecord {
  id: string;
  name: string;
  created_at: string;
  has_config: number;
}

export type UserRole = 'admin' | 'user';

// Свой клиент с точки зрения обычного пользователя: сервер и протокол он видит
// только как подписи — ни хоста, ни контейнера, ни портов ему не отдают.
export interface MyClientRecord extends ClientRecord {
  protocol_id: string;
  protocol_type: ProtocolRecord['type'];
  protocol_config: Record<string, unknown>;
  server_name: string;
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
  clients_count: number;
  created_at: string;
  protocolIds: string[];
}

export interface CurrentUser {
  username: string;
  role: UserRole;
  clientLimit: number;
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
  protocolIds?: string[];
}

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
  create: (data: { protocolId: string; name: string }) => api.post('/clients', data),
  delete: (id: string) => api.delete(`/clients/${id}`),
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
