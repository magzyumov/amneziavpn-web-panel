import { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  clientsApi, protocolsApi, type ClientRecord, type ProtocolRecord, type ServerRecord,
} from '../../api';
import AddClientModal from './AddClientModal';
import ClientModal from './ClientModal';
import StatsModal from './StatsModal';
import CopySubButton from './CopySubButton';

interface ProtocolCardProps {
  protocol: ProtocolRecord;
  server: ServerRecord;
  onDelete: (id: string) => void;
  dragHandleProps?: Record<string, any>;
}

const ICONS: Record<ProtocolRecord['type'], string> = { awg2: '🛡️', xray: '⚡', wireguard: '🔒', mtproxy: '✈️', telemt: '📨' };

function ProtocolCard({ protocol, server: _server, onDelete, dragHandleProps }: ProtocolCardProps) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [showAddClient, setShowAddClient] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientRecord | null>(null);
  const [statsClient, setStatsClient] = useState<ClientRecord | null>(null);
  const [status, setStatus] = useState(protocol.status);
  const [toggling, setToggling] = useState(false);

  useEffect(() => { setStatus(protocol.status); }, [protocol.status]);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState('');
  const [showClients, setShowClients] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [search, setSearch] = useState('');

  // Xray: stats-API может быть выключен на протоколах, поставленных до того
  // как мы стали включать stats в шаблоне. Тогда показываем кнопку Enable.
  const [statsEnabled, setStatsEnabled] = useState<boolean | null>(null);
  const [enablingStats, setEnablingStats] = useState(false);

  useEffect(() => {
    clientsApi.byProtocol(protocol.id).then(r => setClients(r.data)).finally(() => setLoadingClients(false));
    if (protocol.type === 'xray') {
      protocolsApi.statsStatus(protocol.id)
        .then(r => setStatsEnabled(r.data.statsEnabled))
        .catch(() => setStatsEnabled(null));
    }
  }, [protocol.id, protocol.type]);

  const enableStats = async () => {
    if (!confirm('Включить stats? Xray-контейнер будет перезапущен (несколько секунд даунтайма для активных клиентов).')) return;
    setEnablingStats(true);
    try {
      await protocolsApi.enableStats(protocol.id);
      setStatsEnabled(true);
    } catch (e: any) {
      alert('Не удалось включить stats: ' + (e?.response?.data?.error || e?.message));
    } finally {
      setEnablingStats(false);
    }
  };

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
    const r = await protocolsApi.logs(protocol.id, 100);
    setLogs(r.data.logs);
    setShowLogs(true);
  };

  const delClient = async (id: string) => {
    if (!confirm('Delete client?')) return;
    await clientsApi.delete(id);
    setClients(c => c.filter(x => x.id !== id));
  };

  const cfg: Record<string, unknown> | null = typeof protocol.config === 'string'
    ? JSON.parse(protocol.config)
    : (protocol.config as Record<string, unknown> | null);

  return (
    <div className="card" style={{ minWidth: 0, overflow: 'hidden' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-8">
          <span
            {...dragHandleProps}
            title="Перетащить"
            style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, userSelect: 'none', touchAction: 'none' }}
          >⠿</span>
          <span style={{ fontSize: 20 }}>{ICONS[protocol.type]}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{protocol.name}</div>
            <div className="mono text-muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
              :{protocol.port} · {protocol.container_name}
              {cfg && (
                <button onClick={() => setShowConfig(s => !s)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  color: showConfig ? 'var(--accent)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  display: 'inline-flex', alignItems: 'center', gap: 2,
                  transition: 'color 0.15s',
                }}>
                  · ⚙ config
                  <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: showConfig ? 'rotate(180deg)' : 'rotate(0deg)', fontSize: 8 }}>▾</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-8 items-center proto-card-actions">
          <span className={`badge badge-${status === 'running' ? 'running' : 'stopped'}`}>
            {status}
          </span>
          {protocol.type === 'xray' && statsEnabled === false && (
            <button
              className="btn btn-outline btn-sm"
              onClick={enableStats}
              disabled={enablingStats}
              title="Включить stats API в Xray (server.json патчится через jq, контейнер рестартится)"
            >
              {enablingStats ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '📊 Enable stats'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={toggle} disabled={toggling}>
            {toggling ? <span className="spinner" style={{ width: 12, height: 12 }} /> : status === 'running' ? '⏸' : '▶'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={fetchLogs}>📋</button>
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(protocol.id)}>✕</button>
        </div>
      </div>

      {cfg && showConfig && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, minWidth: 0 }}>
          {Object.entries(cfg)
            .filter(([k]) => !['privateKey', 'i1', 'i2', 'i3', 'i4', 'i5'].includes(k))
            .map(([k, v]) => {
              const str = String(v);
              const truncated = str.length > 40 ? str.slice(0, 40) + '…' : str;
              return (
                <div key={k} title={str}
                  style={{ background: 'var(--surface2)', borderRadius: 4, padding: '2px 8px',
                           maxWidth: '100%', overflow: 'hidden' }}>
                  <span className="text-muted mono" style={{ fontSize: 10 }}>{k}: </span>
                  <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{truncated}</span>
                </div>
              );
            })}
        </div>
      )}

      {showLogs && (
        <div style={{ marginBottom: 12 }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 6 }}>
            <span className="input-label">Container Logs</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs(false)}>✕</button>
          </div>
          <div className="terminal">{logs || 'No logs'}</div>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="flex justify-between items-center" style={{ marginBottom: showClients ? 10 : 0 }}>
          <button
            onClick={() => { setShowClients(s => !s); setSearch(''); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <span style={{
              fontSize: 9, display: 'inline-block', transition: 'transform 0.15s',
              transform: showClients ? 'rotate(90deg)' : 'rotate(0deg)', color: 'var(--text-muted)',
            }}>▶</span>
            <span className="input-label" style={{ margin: 0, cursor: 'pointer' }}>
              Clients ({loadingClients ? '…' : clients.length})
            </span>
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => { setShowClients(true); setShowAddClient(true); }}>+ Add</button>
        </div>

        {showClients && (
          loadingClients ? (
            <span className="spinner" style={{ width: 14, height: 14 }} />
          ) : clients.length === 0 ? (
            <div className="text-muted mono" style={{ fontSize: 11 }}>No clients yet</div>
          ) : (() => {
            const q = search.trim().toLowerCase();
            const filtered = q ? clients.filter(c => c.name.toLowerCase().includes(q)) : clients;
            return (
              <div>
                <div style={{ position: 'relative', marginBottom: 10 }}>
                  <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 12, pointerEvents: 'none' }}>⌕</span>
                  <input
                    className="input input-mono"
                    style={{ paddingLeft: 28, fontSize: 12, height: 30 }}
                    placeholder="Search clients…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  {search && (
                    <button onClick={() => setSearch('')} style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: 0,
                    }}>×</button>
                  )}
                </div>

                {q && (
                  <div className="mono text-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                    {filtered.length} из {clients.length}
                    {filtered.length === 0 && ' — ничего не найдено'}
                  </div>
                )}

                {filtered.length > 0 && (() => {
                  const isXray = protocol.type === 'xray';
                  // MTProxy не даёт per-client статистику (официальный mtproto-proxy
                  // отдаёт только глобальные счётчики) — прячем колонку Statistic.
                  const hasStats = protocol.type !== 'mtproxy';
                  // grid: SHARE | (STATISTIC) | (SUBSCRIPTION для xray) | ✕
                  const gridTemplate = [
                    '1fr',
                    hasStats ? '1fr' : null,
                    isXray ? '1fr' : null,
                    '32px',
                  ].filter(Boolean).join(' ');
                  // По умолчанию col-actions = 186px (App.css). Для xray этого мало —
                  // 4 кнопки сжимаются и текст наезжает. Расширяем под фактический контент.
                  const actionsWidth = isXray ? 320 : hasStats ? 220 : 140;
                  const hdrCell: React.CSSProperties = {
                    fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center',
                  };
                  return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 6px 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="col-name" style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className="col-date-hdr">Created</span>
                        <div className="col-actions-hdr" style={{ display: 'grid', gridTemplateColumns: gridTemplate, gap: 8, width: actionsWidth }}>
                          <span style={hdrCell}>Share</span>
                          {hasStats && <span style={hdrCell}>Statistic</span>}
                          {isXray && <span style={hdrCell}>Subscription</span>}
                          <span />
                        </div>
                      </div>
                    </div>
                    {filtered.map(c => (
                      <div key={c.id} style={{ display: 'flex', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface2)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                        <div className="col-name" style={{ fontWeight: 500, paddingRight: 8 }}>
                          {c.name}
                          {!c.has_config && (
                            <span className="mono text-muted" style={{ fontSize: 10, marginLeft: 6 }}>[без конфига]</span>
                          )}
                        </div>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div className="col-date mono text-muted">
                            {c.created_at ? new Date(c.created_at.replace(' ', 'T')).toLocaleDateString() : '—'}
                          </div>
                          <div className="col-actions" style={{ display: 'grid', gridTemplateColumns: gridTemplate, gap: 8, width: actionsWidth }}>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => setSelectedClient(c)}
                              disabled={!c.has_config}
                              title={c.has_config ? undefined : 'Импортированный клиент — конфиг недоступен'}
                            >⬡ View</button>
                            {hasStats && (
                              <button className="btn btn-outline btn-sm" onClick={() => setStatsClient(c)} title="Статистика клиента">📊 Stats</button>
                            )}
                            {isXray && (
                              c.has_config
                                ? <CopySubButton clientId={c.id} />
                                : <span />
                            )}
                            <button className="btn btn-danger btn-sm" onClick={() => delClient(c.id)}>✕</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                  );
                })()}
              </div>
            );
          })()
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
      {statsClient && <StatsModal client={statsClient} protocolType={protocol.type} onClose={() => setStatsClient(null)} />}
    </div>
  );
}

// Sortable wrapper: оборачивает ProtocolCard в dnd-kit useSortable, прокидывает
// attributes/listeners в dragHandleProps дочернего узла (специальный handle "⠿").
export default function SortableProtocolCard(props: ProtocolCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.protocol.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative',
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ProtocolCard {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}
