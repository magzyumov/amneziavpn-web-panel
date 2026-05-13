import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

export const authApi = {
  status: () => api.get('/auth/status'),
  setup: (data) => api.post('/auth/setup', data),
  login: (data) => api.post('/auth/login', data),
};

export const serversApi = {
  list: () => api.get('/servers'),
  create: (data) => api.post('/servers', data),
  delete: (id) => api.delete(`/servers/${id}`),
  test: (id) => api.post(`/servers/${id}/test`),
  ensureDocker: (id) => api.post(`/servers/${id}/ensure-docker`),
  containers: (id) => api.get(`/servers/${id}/containers`),
  update: (id, data) => api.put(`/servers/${id}`, data),
  scanProtocols: (id) => api.post(`/servers/${id}/scan-protocols`),
  importProtocol: (id, data) => api.post(`/servers/${id}/import-protocol`, data),
};

export const protocolsApi = {
  list: () => api.get('/protocols'),
  byServer: (serverId) => api.get(`/protocols/server/${serverId}`),
  install: (serverId, data) => api.post(`/protocols/server/${serverId}`, data),
  delete: (id) => api.delete(`/protocols/${id}`),
  start: (id) => api.post(`/protocols/${id}/start`),
  stop: (id) => api.post(`/protocols/${id}/stop`),
  status: (id) => api.get(`/protocols/${id}/status`),
  health: (serverId) => api.get(`/protocols/server/${serverId}/health`),
  logs: (id, lines) => api.get(`/protocols/${id}/logs`, { params: { lines } }),
};

export const clientsApi = {
  byProtocol: (protocolId) => api.get(`/clients/protocol/${protocolId}`),
  create: (data) => api.post('/clients', data),
  delete: (id) => api.delete(`/clients/${id}`),
  qr: (id) => api.get(`/clients/${id}/qr`),          // returns { qr, amneziaQr, vpnUri }
  configText: (id) => api.get(`/clients/${id}/config-text`), // returns { config, vpnUri, name }
  configDownloadUrl: (id) => `/api/clients/${id}/config`,
  configAmneziaUrl: (id) => `/api/clients/${id}/config-amnezia`,
  subscription: (id) => api.get(`/clients/${id}/subscription`),
};

export async function downloadWithAuth(url, filename) {
  const token = localStorage.getItem('token');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
  delete: (id) => api.delete(`/subscriptions/${id}`),
  getTemplate: () => api.get('/subscriptions/template'),
  saveTemplate: (template) => api.post('/subscriptions/template', { template }),
  resetTemplate: () => api.post('/subscriptions/template/reset'),
  regenerate: () => api.post('/subscriptions/regenerate'),
  getSettings: () => api.get('/subscriptions/settings'),
  saveSettings: (data) => api.post('/subscriptions/settings', data),
  subUrl: (slug) => {
    // Подписка отдаётся через nginx на том же порту что и панель
    const port = window.location.port || '80';
    return `${window.location.protocol}//${window.location.hostname}:${port}/sub/${slug}`;
  },
};
