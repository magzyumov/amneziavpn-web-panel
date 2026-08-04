import { useEffect, useMemo, useState } from 'react';
import {
  usersApi, clientsApi, type PanelUser, type AvailableProtocol, type UserRole,
} from '../api';
import { useCurrentUser } from '../auth';
import { PROTOCOL_ICONS, protocolTitle } from '../protocols';

// Управление пользователями панели. Публичной регистрации нет: аккаунт здесь —
// это доступ к VPN, поэтому пользователей заводит администратор и он же решает,
// какие протоколы (а вместе с ними — и на каком сервере) человеку доступны.
export default function UsersPage() {
  const me = useCurrentUser();
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [protocols, setProtocols] = useState<AvailableProtocol[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PanelUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => Promise.all([usersApi.list(), clientsApi.availableProtocols()])
    .then(([u, p]) => { setUsers(u.data); setProtocols(p.data); })
    .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить пользователей'))
    .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const del = async (u: PanelUser) => {
    if (!confirm(`Удалить пользователя «${u.username}»?\n\nЕго клиенты НЕ удаляются и продолжат работать — они станут «ничьими» и останутся видны админам.`)) return;
    setError(''); setNotice('');
    try {
      const r = await usersApi.delete(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      setNotice(r.data.orphanedClients > 0
        ? `Пользователь удалён. Его клиентов (${r.data.orphanedClients}) отзовите вручную, если доступ больше не нужен.`
        : 'Пользователь удалён.');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось удалить пользователя');
    }
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Пользователи</div>
            <div className="page-sub mono">// {users.length} аккаунтов</div>
          </div>
          <div className="flex gap-8 page-header-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>+ Добавить</button>
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        {notice && <div className="notice notice-success" style={{ marginBottom: 16 }}>{notice}</div>}

        <div className="grid" style={{ gap: 12 }}>
          {users.map(u => (
            <div key={u.id} className="card" style={{ minWidth: 0 }}>
              <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-8">
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{u.username}</span>
                    <span className={`badge badge-${u.role === 'admin' ? 'running' : 'stopped'}`}>{u.role}</span>
                    {u.username === me.username && <span className="mono text-muted" style={{ fontSize: 11 }}>это вы</span>}
                  </div>
                  <div className="mono text-muted" style={{ fontSize: 11 }}>
                    {u.role === 'admin'
                      ? 'полный доступ ко всем серверам и протоколам'
                      : `протоколов выдано: ${u.protocolIds.length} · клиентов: ${u.clients_count}${u.client_limit > 0 ? ` из ${u.client_limit}` : ' (без лимита)'}`}
                  </div>
                </div>
                <div className="flex gap-8 items-center">
                  <button className="btn btn-outline btn-sm" onClick={() => setEditing(u)}>✎ Изменить</button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => del(u)}
                    disabled={u.username === me.username}
                    title={u.username === me.username ? 'Нельзя удалить самого себя' : undefined}
                  >✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {creating && (
        <UserModal
          protocols={protocols}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
      {editing && (
        <UserModal
          user={editing}
          protocols={protocols}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}

interface ModalProps {
  user?: PanelUser;
  protocols: AvailableProtocol[];
  onClose: () => void;
  onSaved: () => void;
}

function UserModal({ user, protocols, onClose, onSaved }: ModalProps) {
  const isEdit = !!user;
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(user?.role ?? 'user');
  const [clientLimit, setClientLimit] = useState(String(user?.client_limit ?? 5));
  const [granted, setGranted] = useState<string[]>(user?.protocolIds ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Протоколы группируем по серверу: администратор мыслит «этому человеку —
  // вот этот сервер», а выдаёт при этом конкретные протоколы на нём.
  const byServer = useMemo(() => {
    const groups = new Map<string, { name: string; items: AvailableProtocol[] }>();
    for (const p of protocols) {
      const g = groups.get(p.server_id) ?? { name: p.server_name, items: [] };
      g.items.push(p);
      groups.set(p.server_id, g);
    }
    return [...groups.entries()];
  }, [protocols]);

  const toggle = (id: string) =>
    setGranted(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const toggleServer = (items: AvailableProtocol[]) => {
    const ids = items.map(p => p.id);
    const allOn = ids.every(id => granted.includes(id));
    setGranted(prev => allOn ? prev.filter(x => !ids.includes(x)) : [...new Set([...prev, ...ids])]);
  };

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const limit = Number(clientLimit) || 0;
      if (isEdit) {
        await usersApi.update(user!.id, {
          role, clientLimit: limit, protocolIds: granted,
          ...(password ? { password } : {}),
        });
      } else {
        await usersApi.create({ username, password, role, clientLimit: limit, protocolIds: granted });
      }
      onSaved();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить');
      setLoading(false);
    }
  };

  const canSubmit = isEdit ? true : (username.length > 0 && password.length >= 8);

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 520, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="modal-title">{isEdit ? `Пользователь ${user!.username}` : 'Новый пользователь'}</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}

        {!isEdit && (
          <div className="input-group">
            <label className="input-label">Логин</label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          </div>
        )}

        <div className="input-group">
          <label className="input-label">{isEdit ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль (минимум 8 символов)'}</label>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </div>

        <div className="input-group">
          <label className="input-label">Роль</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value as UserRole)}>
            <option value="user">user — только свои клиенты на выданных протоколах</option>
            <option value="admin">admin — полный доступ, включая серверы и SSH-креды</option>
          </select>
        </div>

        {role === 'user' && (
          <>
            <div className="input-group">
              <label className="input-label">Лимит клиентов (0 — без ограничения)</label>
              <input className="input input-mono" type="number" min={0} max={1000}
                value={clientLimit} onChange={e => setClientLimit(e.target.value)} />
            </div>

            <div className="input-group">
              <label className="input-label">Доступные протоколы</label>
              {protocols.length === 0 ? (
                <div className="text-muted mono" style={{ fontSize: 11 }}>Ни одного протокола ещё не установлено.</div>
              ) : byServer.map(([serverId, g]) => (
                <div key={serverId} style={{ marginBottom: 10 }}>
                  <button
                    onClick={() => toggleServer(g.items)}
                    className="mono"
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}
                    title="Выдать или снять все протоколы этого сервера"
                  >⊡ {g.name}</button>
                  <div style={{ marginTop: 4 }}>
                    {g.items.map(p => (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer',
                      }}>
                        <input type="checkbox" checked={granted.includes(p.id)} onChange={() => toggle(p.id)} />
                        <span style={{ fontSize: 13 }}>
                          {PROTOCOL_ICONS[p.type]} {protocolTitle({ type: p.type, config: p.config })}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div className="text-muted mono" style={{ fontSize: 10, marginTop: 4 }}>
                // выдача протокола открывает доступ только к нему и к названию его сервера —
                управлять сервером пользователь не сможет
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !canSubmit}>
            {loading ? <span className="spinner" /> : isEdit ? 'Сохранить' : '+ Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
