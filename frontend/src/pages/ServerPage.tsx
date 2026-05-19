import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { serversApi, protocolsApi, type ProtocolRecord, type ServerRecord } from '../api';
import ScanProtocolsModal from './server/ScanProtocolsModal';
import EditServerModal from './server/EditServerModal';
import InstallProtocolModal from './server/InstallProtocolModal';
import SortableProtocolCard from './server/ProtocolCard';

// localStorage-ключ под порядок карточек для конкретного сервера
const ORDER_KEY = (serverId: string) => `protocol-order-${serverId}`;

function applyOrder(protocols: ProtocolRecord[], serverId: string): ProtocolRecord[] {
  try {
    const saved: string[] = JSON.parse(localStorage.getItem(ORDER_KEY(serverId)) || '[]');
    if (!saved.length) return protocols;
    return [...protocols].sort((a, b) => {
      const ai = saved.indexOf(a.id);
      const bi = saved.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  } catch { return protocols; }
}

export default function ServerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [protocols, setProtocols] = useState<ProtocolRecord[]>([]);
  const [showInstall, setShowInstall] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installingDocker, setInstallingDocker] = useState(false);
  const [dockerMsg, setDockerMsg] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const protocolsLoadedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      serversApi.list(),
      protocolsApi.byServer(id),
    ]).then(([sr, pr]) => {
      setServer(sr.data.find(s => s.id === id) ?? null);
      setProtocols(applyOrder(pr.data, id));
      const params = new URLSearchParams(window.location.search);
      if (params.get('scan') === '1') {
        setShowScan(true);
        window.history.replaceState({}, '', window.location.pathname);
      }
    }).then(() => { protocolsLoadedRef.current = true; }).finally(() => setLoading(false));
  }, [id]);

  // Polling реальных статусов каждые 30 секунд
  useEffect(() => {
    if (!id) return;
    const poll = async () => {
      if (!protocolsLoadedRef.current) return;
      try {
        const r = await protocolsApi.health(id);
        setProtocols(prev => prev.map(p => r.data[p.id] !== undefined ? { ...p, status: r.data[p.id] } : p));
      } catch { /* не мешаем работе при недоступности сервера */ }
    };
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [id]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !id) return;
    setProtocols(prev => {
      const oldIdx = prev.findIndex(p => p.id === active.id);
      const newIdx = prev.findIndex(p => p.id === over.id);
      const next = arrayMove(prev, oldIdx, newIdx);
      localStorage.setItem(ORDER_KEY(id), JSON.stringify(next.map(p => p.id)));
      return next;
    });
  };

  const ensureDocker = async () => {
    if (!id) return;
    setInstallingDocker(true);
    setDockerMsg('Installing Docker…');
    try {
      await serversApi.ensureDocker(id);
      setDockerMsg('Docker installed successfully');
    } catch (e: any) {
      setDockerMsg('Error: ' + (e.response?.data?.error || e.message));
    } finally {
      setInstallingDocker(false);
    }
  };

  const delProtocol = async (pid: string) => {
    if (!confirm('Remove protocol and all its clients?')) return;
    await protocolsApi.delete(pid);
    setProtocols(p => p.filter(x => x.id !== pid));
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;
  if (!server || !id) return <div style={{ padding: 48 }}>Server not found</div>;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="flex items-center gap-8">
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
              <div className="page-title">{server.name}</div>
            </div>
            <div className="page-sub mono">// {server.username}@{server.host}:{server.port}</div>
          </div>
          <div className="flex gap-8 page-header-actions">
            <button className="btn btn-outline" onClick={() => setShowEdit(true)}>✎ Edit Server</button>
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
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={protocols.map(p => p.id)} strategy={verticalListSortingStrategy}>
              <div className="grid" style={{ gap: 16, minWidth: 0, overflow: 'hidden' }}>
                {protocols.map(p => (
                  <SortableProtocolCard key={p.id} protocol={p} server={server} onDelete={delProtocol} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
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
      {showEdit && (
        <EditServerModal
          server={server}
          onClose={() => setShowEdit(false)}
          onSaved={updated => { setServer(s => s ? ({ ...s, ...updated }) : s); setShowEdit(false); }}
        />
      )}
    </>
  );
}
