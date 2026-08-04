import { useEffect, useState } from 'react';
import {
  clientsApi, type MyClientRecord, type AvailableProtocol,
} from '../api';
import { useCurrentUser } from '../auth';
import { PROTOCOL_ICONS, protocolTitle } from '../protocols';
import ClientModal from './server/ClientModal';
import StatsModal from './server/StatsModal';
import CopySubButton from './server/CopySubButton';

// Самообслуживание: пользователь заводит себе клиентов на тех протоколах,
// которые ему выдал администратор, и не видит ничего за их пределами —
// ни списка серверов, ни чужих клиентов.
export default function MyClientsPage() {
  const me = useCurrentUser();
  const [clients, setClients] = useState<MyClientRecord[]>([]);
  const [protocols, setProtocols] = useState<AvailableProtocol[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<MyClientRecord | null>(null);
  const [statsFor, setStatsFor] = useState<MyClientRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([clientsApi.mine(), clientsApi.availableProtocols()])
      .then(([c, p]) => { setClients(c.data); setProtocols(p.data); })
      .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить данные'))
      .finally(() => setLoading(false));
  }, []);

  const del = async (c: MyClientRecord) => {
    if (!confirm(`Удалить клиента «${c.name}»? Доступ по этому конфигу перестанет работать.`)) return;
    try {
      await clientsApi.delete(c.id);
      setClients(prev => prev.filter(x => x.id !== c.id));
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось удалить клиента');
    }
  };

  // clientLimit === 0 означает «без ограничения».
  const limit = me.clientLimit;
  const atLimit = limit > 0 && clients.length >= limit;
  const canAdd = protocols.length > 0 && !atLimit;

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Мои клиенты</div>
            <div className="page-sub mono">
              // {clients.length}{limit > 0 ? ` из ${limit}` : ''} · доступно протоколов: {protocols.length}
            </div>
          </div>
          <div className="flex gap-8 page-header-actions">
            <button
              className="btn btn-primary"
              onClick={() => setShowAdd(true)}
              disabled={!canAdd}
              title={
                protocols.length === 0
                  ? 'Администратор ещё не выдал вам ни одного протокола'
                  : atLimit ? `Достигнут лимит в ${limit} клиентов` : undefined
              }
            >+ Новый клиент</button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}

        {atLimit && (
          <div className="notice" style={{ marginBottom: 16 }}>
            Достигнут лимит в {limit} клиентов. Удалите ненужного или попросите администратора поднять лимит.
          </div>
        )}

        {clients.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⬡</div>
            <div className="empty-text">
              {protocols.length === 0
                ? 'Администратор ещё не выдал вам доступ ни к одному протоколу.'
                : 'Пока нет ни одного клиента. Создайте первый — получите конфиг и QR.'}
            </div>
            {canAdd && (
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowAdd(true)}>
                + Создать клиента
              </button>
            )}
          </div>
        ) : (
          <div className="grid" style={{ gap: 12 }}>
            {clients.map(c => (
              <div key={c.id} className="card" style={{ minWidth: 0 }}>
                <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <div className="flex items-center gap-8" style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 20 }}>{PROTOCOL_ICONS[c.protocol_type]}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                      <div className="mono text-muted" style={{ fontSize: 11 }}>
                        {protocolTitle({ type: c.protocol_type, config: c.protocol_config })} · {c.server_name}
                        {c.created_at && ` · ${new Date(c.created_at.replace(' ', 'T')).toLocaleDateString()}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-8 items-center">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setSelected(c)}
                      disabled={!c.has_config}
                      title={c.has_config ? undefined : 'Конфиг этого клиента не сохранён'}
                    >⬡ Конфиг</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setStatsFor(c)}>📊 Статистика</button>
                    {c.protocol_type === 'xray' && !!c.has_config && <CopySubButton clientId={c.id} />}
                    <button className="btn btn-danger btn-sm" onClick={() => del(c)}>✕</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddMyClientModal
          protocols={protocols}
          onClose={() => setShowAdd(false)}
          onAdded={c => { setClients(prev => [c, ...prev]); setShowAdd(false); }}
        />
      )}
      {selected && <ClientModal client={selected} protocolType={selected.protocol_type} onClose={() => setSelected(null)} />}
      {statsFor && <StatsModal client={statsFor} protocolType={statsFor.protocol_type} onClose={() => setStatsFor(null)} />}
    </>
  );
}

interface AddProps {
  protocols: AvailableProtocol[];
  onClose: () => void;
  onAdded: (client: MyClientRecord) => void;
}

function AddMyClientModal({ protocols, onClose, onAdded }: AddProps) {
  const [name, setName] = useState('');
  const [protocolId, setProtocolId] = useState(protocols[0]?.id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name || !protocolId) return;
    setLoading(true);
    setError('');
    try {
      const r = await clientsApi.create({ protocolId, name });
      const proto = protocols.find(p => p.id === protocolId)!;
      // POST /clients отдаёт саму запись; сервер и протокол дописываем из выбора,
      // чтобы не перезапрашивать весь список ради одной новой карточки.
      onAdded({
        id: r.data.id,
        name: r.data.name,
        created_at: r.data.created_at,
        has_config: 1,
        protocol_id: proto.id,
        protocol_type: proto.type,
        protocol_config: proto.config,
        server_name: proto.server_name,
      });
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось создать клиента');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420 }}>
        <div className="modal-title">Новый клиент</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div className="input-group">
          <label className="input-label">Протокол</label>
          <select className="input" value={protocolId} onChange={e => setProtocolId(e.target.value)}>
            {protocols.map(p => (
              <option key={p.id} value={p.id}>
                {PROTOCOL_ICONS[p.type]} {protocolTitle({ type: p.type, config: p.config })} — {p.server_name}
              </option>
            ))}
          </select>
        </div>

        <div className="input-group">
          <label className="input-label">Название устройства</label>
          <input className="input" placeholder="напр. iPhone, Ноутбук" value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
        </div>

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !name || !protocolId}>
            {loading ? <span className="spinner" /> : '+ Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
