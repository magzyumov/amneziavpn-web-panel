import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { serversApi, protocolsApi, clientsApi } from '../api.js';
import { subscriptionsApi } from '../api.js';

// ── Scan Existing Protocols Modal ───────────────────────────────────────────
function ScanProtocolsModal({ serverId, existingProtocols, onClose, onImported }) {
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState(null);
  const [importing, setImporting] = useState({});
  const [imported, setImported] = useState({});
  const [error, setError] = useState('');

  const typeIcons = { awg2: '🛡️', wireguard: '🔒', xray: '⚡' };
  const typeNames = { awg2: 'AmneziaWG 2.0', wireguard: 'WireGuard', xray: 'Xray VLESS Reality' };

  const scan = async () => {
    setScanning(true);
    setError('');
    setFound(null);
    try {
      const r = await serversApi.scanProtocols(serverId);
      setFound(r.data.found || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => { scan(); }, []);

  const alreadyImported = (containerName) =>
    existingProtocols.some(p => p.container_name === containerName);

  const doImport = async (proto) => {
    setImporting(s => ({ ...s, [proto.containerName]: true }));
    try {
      const r = await serversApi.importProtocol(serverId, {
        type: proto.type,
        containerName: proto.containerName,
        port: proto.port,
        config: proto.config,
        clients: proto.clients || [],
      });
      setImported(s => ({ ...s, [proto.containerName]: r.data }));
      onImported(r.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setImporting(s => ({ ...s, [proto.containerName]: false }));
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !scanning && onClose()}>
      <div className="modal" style={{ width: 560 }}>
        <div className="modal-title">🔍 Scan Server for Existing Protocols</div>

        {scanning && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <span className="spinner" style={{ width: 24, height: 24 }} />
            <div className="text-muted" style={{ marginTop: 12, fontSize: 13 }}>Scanning server for Amnezia containers…</div>
          </div>
        )}

        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}

        {found !== null && !scanning && (
          found.length === 0 ? (
            <div className="notice notice-info">No Amnezia protocols found on this server.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="notice notice-info" style={{ fontSize: 12 }}>
                Found <b>{found.length}</b> protocol{found.length !== 1 ? 's' : ''} on the server.
                Import them to manage clients and configurations.
              </div>
              {found.map(proto => {
                const alreadyIn = alreadyImported(proto.containerName);
                const isImporting = importing[proto.containerName];
                const isImported = imported[proto.containerName];
                return (
                  <div key={proto.containerName} style={{
                    background: 'var(--surface2)',
                    borderRadius: 8,
                    padding: '12px 16px',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {typeIcons[proto.type]} {typeNames[proto.type] || proto.type}
                      </div>
                      <div className="mono text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {proto.containerName} · port {proto.port || '?'} · <span style={{
                          color: proto.status === 'running' ? 'var(--green)' : 'var(--text-muted)'
                        }}>{proto.status}</span>
                      </div>
                      {proto.clients?.length > 0 && (
                        <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
                          {proto.clients.length} client{proto.clients.length !== 1 ? 's' : ''} найдено
                          {proto.type !== 'xray' && <span className="text-muted"> (без конфига — приватный ключ на устройстве)</span>}
                          {isImported && (
                            <span style={{ color: 'var(--green)', marginLeft: 6 }}>
                              ✓ {isImported.importedClients} импортировано
                            </span>
                          )}
                          {!isImported && proto.clients.length > 0 && (
                            <div className="mono" style={{ marginTop: 4, maxHeight: 80, overflowY: 'auto' }}>
                              {proto.clients.map((cl, i) => (
                                <div key={i} style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {cl.name}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div>
                      {alreadyIn || isImported ? (
                        <span className="badge badge-running">✓ Imported</span>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => doImport(proto)}
                          disabled={isImporting}
                        >
                          {isImporting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⬇ Import'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        <div className="modal-actions" style={{ marginTop: 20 }}>
          <button className="btn btn-outline" onClick={scan} disabled={scanning}>
            {scanning ? <><span className="spinner" /> Scanning…</> : '↻ Re-scan'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}


function InstallProtocolModal({ serverId, onClose, onInstalled }) {
  const [type, setType] = useState('awg2');
  const [opts, setOpts] = useState({});
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');

  const set = (k, v) => setOpts(o => ({ ...o, [k]: v }));

  const defaults = {
    // AWG2: параметры H — диапазоны, генерируются на сервере если не указаны
    awg2:      { port: '', jc: 6, jmin: 10, jmax: 50, s1: 143, s2: 122, s3: 59, s4: 17 },
    xray:      { port: 443, sni: 'www.googletagmanager.com' },
    wireguard: { port: '' },
  };

  useEffect(() => { setOpts(defaults[type] || {}); }, [type]);

  const install = async () => {
    setLoading(true);
    setError('');
    setLog(`► Installing ${type}...\n► Pulling Docker image (может занять минуту)...\n`);
    try {
      // Убираем пустые порты (сервер сгенерирует случайный)
      const options = { ...opts };
      if (!options.port) delete options.port;
      const r = await protocolsApi.install(serverId, { type, options });
      setLog(l => l + `\n✓ Done!\n  Container: ${r.data.containerName}\n  Port: ${r.data.port}\n`);
      setTimeout(() => { onInstalled(r.data); }, 1200);
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      setError(msg);
      setLog(l => l + `\n✗ Error: ${msg}\n`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !loading && onClose()}>
      <div className="modal" style={{ width: 540 }}>
        <div className="modal-title">Install Protocol</div>

        <div className="input-group" style={{ marginBottom: 16 }}>
          <label className="input-label">Protocol</label>
          <select className="input" value={type} onChange={e => setType(e.target.value)}>
            <option value="awg2">🛡️ AmneziaWG 2.0</option>
            <option value="xray">⚡ Xray VLESS Reality</option>
            <option value="wireguard">🔒 WireGuard</option>
          </select>
        </div>

        {type === 'awg2' && (
          <div>
            <div className="notice notice-info" style={{ marginBottom: 12, fontSize: 11 }}>
              Порт и параметры H1-H4 генерируются автоматически если не заданы
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { k: 'port',  label: 'UDP Port (пусто = random)' },
                { k: 'jc',   label: 'Jc (junk count, 3-10)' },
                { k: 'jmin', label: 'Jmin' },
                { k: 'jmax', label: 'Jmax' },
                { k: 's1',   label: 'S1' },
                { k: 's2',   label: 'S2' },
                { k: 's3',   label: 'S3' },
                { k: 's4',   label: 'S4' },
              ].map(f => (
                <div key={f.k} className="input-group">
                  <label className="input-label">{f.label}</label>
                  <input className="input input-mono" type="number"
                    value={opts[f.k] ?? ''} placeholder="auto"
                    onChange={e => set(f.k, e.target.value === '' ? '' : +e.target.value)} />
                </div>
              ))}
            </div>
          </div>
        )}

        {type === 'xray' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="input-group">
              <label className="input-label">Port</label>
              <input className="input input-mono" type="number" value={opts.port ?? 443}
                onChange={e => set('port', +e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">SNI — Reality target domain</label>
              <input className="input input-mono" value={opts.sni ?? ''}
                onChange={e => set('sni', e.target.value)} />
            </div>
            <div className="notice notice-info" style={{ fontSize: 11 }}>
              Reality ключи генерируются автоматически через xray x25519
            </div>
          </div>
        )}

        {type === 'wireguard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="input-group">
              <label className="input-label">UDP Port (пусто = random)</label>
              <input className="input input-mono" type="number" placeholder="auto"
                value={opts.port ?? ''} onChange={e => set('port', e.target.value === '' ? '' : +e.target.value)} />
            </div>
          </div>
        )}

        {log && <div className="terminal" style={{ marginTop: 16 }}>{log}</div>}
        {error && <div className="notice notice-error" style={{ marginTop: 12 }}>{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn btn-primary" onClick={install} disabled={loading}>
            {loading ? <><span className="spinner" /> Installing…</> : '▶ Install'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Client Modal ────────────────────────────────────────
function ClientModal({ client, protocolType, onClose }) {
  // format: 'amnezia' | 'original'  (только для awg2/wireguard)
  const [format, setFormat] = useState('amnezia');
  const [tab, setTab]       = useState('qr');

  const [origQr,    setOrigQr]    = useState(null);
  const [amneziaQr, setAmneziaQr] = useState(null);
  const [vpnUri,    setVpnUri]    = useState('');
  const [origConf,  setOrigConf]  = useState('');
  const [loadingQr, setLoadingQr] = useState(true);

  const isXray = protocolType === 'xray';
  const hasAmnezia = protocolType === 'awg2' || protocolType === 'wireguard';

  useEffect(() => {
    if (!client.has_config) { setLoadingQr(false); return; }
    setLoadingQr(true);
    clientsApi.qr(client.id).then(r => {
      setOrigQr(r.data.qr);
      setAmneziaQr(r.data.amneziaQr || null);
      setVpnUri(r.data.vpnUri || '');
    }).catch(() => setOrigQr(null)).finally(() => setLoadingQr(false));

    clientsApi.configText(client.id).then(r => {
      setOrigConf(r.data.config || '');
      if (r.data.vpnUri) setVpnUri(r.data.vpnUri);
    });
  }, [client.id]);

  // Активные значения в зависимости от выбранного формата
  const activeQr     = (hasAmnezia && format === 'amnezia') ? amneziaQr   : origQr;
  const activeConfig = (hasAmnezia && format === 'amnezia') ? (vpnUri || '') : origConf;
  const activeHint   = hasAmnezia && format === 'amnezia'
    ? 'Сканируйте в приложении AmneziaVPN (поддерживает vpn:// ссылки)'
    : isXray ? 'Сканируйте в FLClash, v2rayNG или совместимом клиенте' : 'Сканируйте в стандартном WireGuard клиенте';

  const activeDownloadUrl  = (hasAmnezia && format === 'amnezia')
    ? clientsApi.configAmneziaUrl(client.id)
    : clientsApi.configDownloadUrl(client.id);
  const activeDownloadLabel = (hasAmnezia && format === 'amnezia') ? '⬇ JSON для Amnezia' : '⬇ Скачать .conf';

  const tabs = [
    { id: 'qr',  label: 'QR-код' },
    { id: 'cfg', label: isXray ? 'VLESS URI' : format === 'amnezia' ? 'vpn:// URI' : '.conf' },
  ];

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 500 }}>

        {/* Заголовок */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div className="modal-title" style={{ margin: 0 }}>{client.name}</div>
            <div className="text-muted mono" style={{ fontSize: 11, marginTop: 4 }}>
              {protocolType?.toUpperCase()}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {/* Клиент импортирован без конфига */}
        {!client.has_config && (
          <div className="notice notice-info" style={{ marginBottom: 16, fontSize: 12 }}>
            Этот клиент импортирован с сервера. Приватный ключ хранится только на устройстве клиента —
            конфиг и QR недоступны. Для переподключения создайте нового клиента.
          </div>
        )}

        {/* Переключатель формата (только для AWG и WireGuard) */}
        {hasAmnezia && client.has_config && (
          <div style={{
            display: 'flex', gap: 0, marginBottom: 16,
            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
          }}>
            <button
              style={{
                flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
                background: format === 'amnezia' ? 'var(--accent)' : 'transparent',
                color: format === 'amnezia' ? '#fff' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer', transition: 'all .15s',
              }}
              onClick={() => setFormat('amnezia')}
            >
              📱 Для приложения Amnezia
            </button>
            <button
              style={{
                flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
                background: format === 'original' ? 'var(--accent)' : 'transparent',
                color: format === 'original' ? '#fff' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer', borderLeft: '1px solid var(--border)', transition: 'all .15s',
              }}
              onClick={() => setFormat('original')}
            >
              📄 Оригинальный формат
            </button>
          </div>
        )}

        {client.has_config && (<>
          {/* Вкладки QR / текст */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {tabs.map(t => (
              <button key={t.id}
                className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {/* QR-код */}
          {tab === 'qr' && (
            <div style={{ textAlign: 'center' }}>
              {loadingQr ? (
                <div style={{ padding: 60 }}><span className="spinner" style={{ width: 28, height: 28 }} /></div>
              ) : activeQr ? (
                <img src={activeQr} alt="QR" style={{ width: 280, height: 280, borderRadius: 8 }} />
              ) : (
                <div className="notice notice-error">Не удалось сгенерировать QR</div>
              )}
              <div className="text-muted" style={{ marginTop: 12, fontSize: 11 }}>{activeHint}</div>
            </div>
          )}

          {/* Текст конфига / URI */}
          {tab === 'cfg' && (
            <div>
              {hasAmnezia && format === 'amnezia' ? (
                <>
                  <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 11 }}>
                    <b>vpn://</b> ссылка — вставьте или отсканируйте в AmneziaVPN (iOS / Android / Desktop)
                  </div>
                  <div className="config-box" style={{ fontSize: 10, wordBreak: 'break-all', maxHeight: 160, overflowY: 'auto' }}>
                    {vpnUri || 'Генерация…'}
                  </div>
                </>
              ) : (
                <>
                  {isXray && (
                    <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 11 }}>
                      VLESS URI — для FLClash, Clash Meta, v2rayNG
                    </div>
                  )}
                  <div className="config-box" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {origConf || 'Загрузка…'}
                  </div>
                </>
              )}
            </div>
          )}
        </>)}

        {/* Кнопки */}
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-outline" onClick={onClose}>Закрыть</button>
          {client.has_config && (
            <button className="btn btn-primary" onClick={() => window.open(activeDownloadUrl, '_blank')}>
              {activeDownloadLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Add Client Modal ─────────────────────────────────────
function AddClientModal({ protocolId, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name) return;
    setLoading(true);
    setError('');
    try {
      const r = await clientsApi.create({ protocolId, name });
      onAdded(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 380 }}>
        <div className="modal-title">Add Client</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="input-group">
          <label className="input-label">Client Name</label>
          <input className="input" placeholder="e.g. iPhone, Laptop" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !name}>
            {loading ? <span className="spinner" /> : '+ Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Copy Subscription URL Button ────────────────────────
// Универсальное копирование в буфер — работает и на HTTP (не только HTTPS)
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback для HTTP
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function CopySubButton({ clientId }) {
  const [slug, setSlug] = useState(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState(null);

  const fetchAndCopy = async () => {
    setLoading(true);
    try {
      let s = slug;
      if (!s) {
        const r = await clientsApi.subscription(clientId);
        s = r.data.slug;
        setSlug(s);
      }
      if (!s) { alert('Подписка не найдена'); return; }
      const subUrl = subscriptionsApi.subUrl(s);
      setUrl(subUrl);
      await copyToClipboard(subUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`btn btn-sm ${copied ? 'btn-primary' : 'btn-outline'}`}
      onClick={fetchAndCopy}
      disabled={loading}
      title={url || 'Скопировать URL подписки для FLClash'}
    >
      {loading
        ? <span className="spinner" style={{ width: 12, height: 12 }} />
        : copied ? '✓ Copied' : '📡 Sub URL'}
    </button>
  );
}

// ── Protocol Card ────────────────────────────────────────
function ProtocolCard({ protocol, server, onDelete }) {
  const [clients, setClients] = useState([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [showAddClient, setShowAddClient] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null);
  const [status, setStatus] = useState(protocol.status);
  const [toggling, setToggling] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState('');

  const icons = { awg2: '🛡️', xray: '⚡', wireguard: '🔒' };

  useEffect(() => {
    clientsApi.byProtocol(protocol.id).then(r => setClients(r.data)).finally(() => setLoadingClients(false));
  }, [protocol.id]);

  const toggle = async () => {
    setToggling(true);
    try {
      if (status === 'running') {
        await protocolsApi.stop(protocol.id);
        setStatus('stopped');
      } else {
        await protocolsApi.start(protocol.id);
        setStatus('running');
      }
    } finally {
      setToggling(false);
    }
  };

  const fetchLogs = async () => {
    const r = await protocolsApi.logs(protocol.id);
    setLogs(r.data.logs);
    setShowLogs(true);
  };

  const delClient = async (id) => {
    if (!confirm('Delete client?')) return;
    await clientsApi.delete(id);
    setClients(c => c.filter(x => x.id !== id));
  };

  const cfg = typeof protocol.config === 'string' ? JSON.parse(protocol.config) : protocol.config;

  return (
    <div className="card">
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-8">
          <span style={{ fontSize: 20 }}>{icons[protocol.type]}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{protocol.name}</div>
            <div className="mono text-muted" style={{ fontSize: 11 }}>:{protocol.port} · {protocol.container_name}</div>
          </div>
        </div>
        <div className="flex gap-8 items-center">
          <span className={`badge badge-${status === 'running' ? 'running' : 'stopped'}`}>
            {status}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={toggle} disabled={toggling}>
            {toggling ? <span className="spinner" style={{ width: 12, height: 12 }} /> : status === 'running' ? '⏸' : '▶'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={fetchLogs}>📋</button>
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(protocol.id)}>✕</button>
        </div>
      </div>

      {/* Config summary */}
      {cfg && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          {Object.entries(cfg).filter(([k]) => !['privateKey'].includes(k)).map(([k, v]) => (
            <div key={k} style={{ background: 'var(--surface2)', borderRadius: 4, padding: '2px 8px' }}>
              <span className="text-muted mono" style={{ fontSize: 10 }}>{k}: </span>
              <span className="mono" style={{ fontSize: 11 }}>{String(v)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Logs */}
      {showLogs && (
        <div style={{ marginBottom: 12 }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 6 }}>
            <span className="input-label">Container Logs</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs(false)}>✕</button>
          </div>
          <div className="terminal">{logs || 'No logs'}</div>
        </div>
      )}

      {/* Clients */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
          <span className="input-label">Clients ({clients.length})</span>
          <button className="btn btn-outline btn-sm" onClick={() => setShowAddClient(true)}>+ Add</button>
        </div>

        {loadingClients ? (
          <span className="spinner" style={{ width: 14, height: 14 }} />
        ) : clients.length === 0 ? (
          <div className="text-muted mono" style={{ fontSize: 11 }}>No clients yet</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>
                    {c.name}
                    {!c.has_config && (
                      <span className="mono text-muted" style={{ fontSize: 10, marginLeft: 6 }}>[без конфига]</span>
                    )}
                  </td>
                  <td className="mono text-muted" style={{ fontSize: 11 }}>
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <div className="flex gap-8">
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelectedClient(c)}>⬡ View</button>
                      {protocol.type === 'xray' && c.has_config && (
                        <CopySubButton clientId={c.id} />
                      )}
                      <button className="btn btn-danger btn-sm" onClick={() => delClient(c.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAddClient && (
        <AddClientModal
          protocolId={protocol.id}
          onClose={() => setShowAddClient(false)}
          onAdded={c => { setClients(p => [...p, c]); setShowAddClient(false); }}
        />
      )}
      {selectedClient && <ClientModal client={selectedClient} protocolType={protocol.type} onClose={() => setSelectedClient(null)} />}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────
export default function ServerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [protocols, setProtocols] = useState([]);
  const [showInstall, setShowInstall] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installingDocker, setInstallingDocker] = useState(false);
  const [dockerMsg, setDockerMsg] = useState('');

  useEffect(() => {
    Promise.all([
      serversApi.list(),
      protocolsApi.byServer(id),
    ]).then(([sr, pr]) => {
      setServer(sr.data.find(s => s.id === id));
      setProtocols(pr.data);
      // Auto-open scan if redirected from "Add Server"
      const params = new URLSearchParams(window.location.search);
      if (params.get('scan') === '1') {
        setShowScan(true);
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
      }
    }).finally(() => setLoading(false));
  }, [id]);

  const ensureDocker = async () => {
    setInstallingDocker(true);
    setDockerMsg('Installing Docker…');
    try {
      await serversApi.ensureDocker(id);
      setDockerMsg('Docker installed successfully');
    } catch (e) {
      setDockerMsg('Error: ' + (e.response?.data?.error || e.message));
    } finally {
      setInstallingDocker(false);
    }
  };

  const delProtocol = async (pid) => {
    if (!confirm('Remove protocol and all its clients?')) return;
    await protocolsApi.delete(pid);
    setProtocols(p => p.filter(x => x.id !== pid));
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;
  if (!server) return <div style={{ padding: 48 }}>Server not found</div>;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-8">
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
              <div className="page-title">{server.name}</div>
            </div>
            <div className="page-sub mono">// {server.username}@{server.host}:{server.port}</div>
          </div>
          <div className="flex gap-8">
            <button className="btn btn-outline" onClick={ensureDocker} disabled={installingDocker}>
              {installingDocker ? <><span className="spinner" /> Installing Docker…</> : '🐳 Ensure Docker'}
            </button>
            <button className="btn btn-outline" onClick={() => setShowScan(true)}>🔍 Scan Server</button>
            <button className="btn btn-primary" onClick={() => setShowInstall(true)}>+ Install Protocol</button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {dockerMsg && (
          <div className={`notice ${dockerMsg.includes('Error') ? 'notice-error' : 'notice-success'}`} style={{ marginBottom: 16 }}>
            {dockerMsg}
          </div>
        )}

        {protocols.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">◈</div>
            <div className="empty-text">No protocols installed yet.</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowInstall(true)}>
              + Install First Protocol
            </button>
          </div>
        ) : (
          <div className="grid" style={{ gap: 16 }}>
            {protocols.map(p => (
              <ProtocolCard key={p.id} protocol={p} server={server} onDelete={delProtocol} />
            ))}
          </div>
        )}
      </div>

      {showInstall && (
        <InstallProtocolModal
          serverId={id}
          onClose={() => setShowInstall(false)}
          onInstalled={p => { setProtocols(prev => [...prev, p]); setShowInstall(false); }}
        />
      )}
      {showScan && (
        <ScanProtocolsModal
          serverId={id}
          existingProtocols={protocols}
          onClose={() => setShowScan(false)}
          onImported={p => {
            setProtocols(prev => {
              if (prev.some(x => x.id === p.id || x.container_name === p.containerName)) return prev;
              return [...prev, p];
            });
          }}
        />
      )}
    </>
  );
}
