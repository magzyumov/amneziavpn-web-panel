import { useEffect, useState } from 'react';
import {
  clientsApi, type MyClientRecord, type AvailableProtocol,
} from '../api';
import { useCurrentUser } from '../auth';
import { PROTOCOL_ICONS, protocolTitle } from '../protocols';
import ClientModal from './server/ClientModal';
import StatsModal from './server/StatsModal';
import CopySubButton from './server/CopySubButton';
import LimitBadges from './server/LimitBadges';
import { formatBytes, formatRelativeTime } from './server/format';

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

  const onlineCount = clients.filter(c => c.online).length;
  const todayTotal = clients.reduce((sum, c) => sum + c.used_today, 0);
  const weekTotal = clients.reduce((sum, c) => sum + c.week_rx + c.week_tx, 0);
  // Суммарный суточный лимит имеет смысл показывать, только если он есть у всех:
  // иначе «5 ГБ в сутки» рядом с безлимитным клиентом вводит в заблуждение.
  const dailyLimitTotal = clients.every(c => c.daily_limit_bytes > 0)
    ? clients.reduce((sum, c) => sum + c.daily_limit_bytes, 0)
    : 0;

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
                  : atLimit ? `Достигнут лимит в ${limit} клиентов`
                  : 'Создать клиента: панель сгенерирует ключи и выдаст конфиг с QR-кодом'
              }
            >+ Новый клиент</button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}

        {/* Личная сводка: пользователь не видит инфраструктуру, но про свой
            расход должен знать столько же, сколько администратор. */}
        {clients.length > 0 && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 16, alignItems: 'start' }}>
            <MiniTile label="Устройства" value={limit > 0 ? `${clients.length} / ${limit}` : String(clients.length)}
              sub={limit > 0 ? 'использовано / лимит' : 'без ограничения'} warn={atLimit} />
            <MiniTile label="Онлайн сейчас" value={onlineCount}
              sub={onlineCount > 0 ? 'подключены' : 'никто не подключён'} accent={onlineCount > 0} />
            <MiniTile label="Трафик сегодня" value={formatBytes(todayTotal)}
              sub={dailyLimitTotal > 0 ? `лимит ${formatBytes(dailyLimitTotal)} в сутки` : 'без суточного лимита'}
              warn={dailyLimitTotal > 0 && todayTotal >= dailyLimitTotal} />
            <MiniTile label="Трафик за неделю" value={formatBytes(weekTotal)} sub="за последние 7 дней" />
          </div>
        )}

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
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowAdd(true)}
                title="Создать клиента: панель сгенерирует ключи и выдаст конфиг с QR-кодом">
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
                      <div className="flex items-center gap-8" style={{ flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                        {c.online
                          ? <span className="badge badge-running">онлайн</span>
                          : c.last_handshake
                            ? <span className="mono text-muted" style={{ fontSize: 10 }}>
                                был {formatRelativeTime(c.last_handshake)}
                              </span>
                            : null}
                      </div>
                      <div className="mono text-muted" style={{ fontSize: 11 }}>
                        {protocolTitle({ type: c.protocol_type, config: c.protocol_config })} · {c.server_name}
                        {c.created_at && ` · ${new Date(c.created_at.replace(' ', 'T')).toLocaleDateString()}`}
                      </div>
                      <div className="mono text-muted" style={{ fontSize: 11 }}>
                        за неделю: {formatBytes(c.week_rx + c.week_tx)}
                        {' '}(↓ {formatBytes(c.week_rx)} · ↑ {formatBytes(c.week_tx)})
                      </div>
                      <LimitBadges {...c} />
                    </div>
                  </div>
                  <div className="flex gap-8 items-center">
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => setSelected(c)}
                      disabled={!c.has_config}
                      title={c.has_config
                        ? 'Конфиг, QR-код и файл для импорта в приложение'
                        : 'Конфиг этого клиента не сохранён'}
                    >⬡ Конфиг</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setStatsFor(c)}
                      title="Принято и отправлено за период, онлайн-статус, график скорости">📊 Статистика</button>
                    {c.protocol_type === 'xray' && !!c.has_config && <CopySubButton clientId={c.id} />}
                    <button className="btn btn-danger btn-sm" onClick={() => del(c)}
                      title="Удалить клиента: пир снимается с сервера, конфиг перестаёт работать">✕</button>
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
          expiryDays={me.defaultExpiryDays}
          dailyLimitMb={me.defaultDailyLimitMb}
          onClose={() => setShowAdd(false)}
          onAdded={c => { setClients(prev => [c, ...prev]); setShowAdd(false); }}
        />
      )}
      {selected && <ClientModal client={selected} protocolType={selected.protocol_type} onClose={() => setSelected(null)} />}
      {statsFor && <StatsModal client={statsFor} protocolType={statsFor.protocol_type} onClose={() => setStatsFor(null)} />}
    </>
  );
}

// Плитка личной сводки. Отдельная от дашбордной: там она умеет вести по ссылке
// и знает про предупреждения инфраструктуры, здесь этого не нужно.
interface MiniTileProps {
  label: string; value: string | number; sub?: string;
  warn?: boolean; accent?: boolean;
}

function MiniTile({ label, value, sub, warn, accent }: MiniTileProps) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="mono text-muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, marginTop: 4, lineHeight: 1.1,
        color: warn ? 'var(--danger, #e5534b)' : accent ? 'var(--accent)' : undefined,
      }}>{value}</div>
      {sub && <div className="mono text-muted" style={{ fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

interface AddProps {
  protocols: AvailableProtocol[];
  /** Лимиты, заданные администратором для этого пользователя. Только показ. */
  expiryDays: number;
  dailyLimitMb: number;
  onClose: () => void;
  onAdded: (client: MyClientRecord) => void;
}

function AddMyClientModal({ protocols, expiryDays, dailyLimitMb, onClose, onAdded }: AddProps) {
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
      // POST /clients отдаёт саму запись вместе с применёнными лимитами; сервер и
      // протокол дописываем из выбора, чтобы не перезапрашивать весь список ради
      // одной новой карточки.
      onAdded({
        id: r.data.id,
        name: r.data.name,
        created_at: r.data.created_at,
        has_config: 1,
        expires_at: r.data.expires_at ?? null,
        daily_limit_bytes: r.data.daily_limit_bytes ?? 0,
        suspended_at: null,
        used_today: 0,
        // Новый клиент ещё ни разу не подключался — трафика и рукопожатия нет.
        week_rx: 0,
        week_tx: 0,
        last_handshake: null,
        online: false,
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

        {(expiryDays > 0 || dailyLimitMb > 0) && (
          <div className="notice" style={{ marginBottom: 12, fontSize: 12 }}>
            Ограничения, заданные администратором:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {expiryDays > 0 && <li>срок действия — {expiryDays} дн., затем клиент удаляется</li>}
              {dailyLimitMb > 0 && (
                <li>не более {dailyLimitMb} МБ в сутки; при исчерпании доступ приостановится до начала новых суток</li>
              )}
            </ul>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !name || !protocolId}
            title="Создать клиента на выбранном протоколе">
            {loading ? <span className="spinner" /> : '+ Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
