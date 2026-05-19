import { useEffect, useState } from 'react';
import { serversApi } from '../../api';

interface Props {
  serverId: string;
  existingProtocols: Array<{ container_name: string }>;
  onClose: () => void;
  onImported: (data: any) => void;
}

interface FoundProto {
  type: 'awg2' | 'wireguard' | 'xray';
  containerName: string;
  port: number | null;
  status: string;
  config: Record<string, any>;
  clients: Array<{ clientId: string; name: string }>;
}

const TYPE_ICONS: Record<string, string> = { awg2: '🛡️', wireguard: '🔒', xray: '⚡' };
const TYPE_NAMES: Record<string, string> = { awg2: 'AmneziaWG 2.0', wireguard: 'WireGuard', xray: 'Xray VLESS Reality' };

export default function ScanProtocolsModal({ serverId, existingProtocols, onClose, onImported }: Props) {
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<FoundProto[] | null>(null);
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState<Record<string, any>>({});
  const [error, setError] = useState('');

  const scan = async () => {
    setScanning(true);
    setError('');
    setFound(null);
    try {
      const r = await serversApi.scanProtocols(serverId);
      setFound(r.data.found || []);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => { scan(); }, []);

  const alreadyImported = (containerName: string) =>
    existingProtocols.some(p => p.container_name === containerName);

  const doImport = async (proto: FoundProto) => {
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
    } catch (e: any) {
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
                        {TYPE_ICONS[proto.type]} {TYPE_NAMES[proto.type] || proto.type}
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
