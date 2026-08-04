import { useEffect, useState } from 'react';
import { auditApi, type AuditRecord, type AuditResponse, type AuditStatus, type AuditQuery } from '../api';

const PAGE_SIZE = 50;

// Человеческие названия действий. Незнакомое действие показываем как есть —
// лучше техническая строка, чем пустая ячейка.
const ACTION_LABELS: Record<string, string> = {
  'auth.login':  'вошёл в панель',
  'auth.logout': 'вышел',
  'auth.setup':  'первичная настройка панели',

  'user.create': 'создал пользователя',
  'user.update': 'изменил пользователя',
  'user.delete': 'удалил пользователя',

  'client.create':   'создал клиента',
  'client.delete':   'удалил клиента',
  'client.limits':   'изменил лимиты клиента',
  'client.download': 'скачал конфиг',

  'protocol.install':      'установил протокол',
  'protocol.import':       'импортировал протокол',
  'protocol.delete':       'удалил протокол',
  'protocol.start':        'запустил протокол',
  'protocol.stop':         'остановил протокол',
  'protocol.enable_stats': 'включил статистику Xray',

  'server.create':        'добавил сервер',
  'server.update':        'изменил сервер',
  'server.delete':        'удалил сервер',
  'server.test':          'проверил связь с сервером',
  'server.ensure_docker': 'установил Docker',
  'server.dns_install':   'установил AmneziaDNS',
  'server.dns_remove':    'удалил AmneziaDNS',
  'server.scan':          'просканировал сервер',
  'server.probe':         'опросил серверы',

  'subscription.template':       'изменил шаблон подписок',
  'subscription.template_reset': 'сбросил шаблон подписок',
  'subscription.regenerate':     'перевыпустил подписки',
  'subscription.settings':       'изменил настройки подписок',
  'subscription.delete':         'удалил подписку',
};

const STATUS_LABELS: Record<AuditStatus, string> = {
  ok: 'выполнено',
  denied: 'отказано',
  failed: 'ошибка',
};

export default function AuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<{ username: string; action: string; status: string }>({
    username: '', action: '', status: '',
  });

  useEffect(() => {
    setLoading(true);
    const params: AuditQuery = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (filter.username) params.username = filter.username;
    if (filter.action) params.action = filter.action;
    if (filter.status) params.status = filter.status as AuditStatus;

    auditApi.list(params)
      .then(r => { setData(r.data); setError(''); })
      .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить журнал'))
      .finally(() => setLoading(false));
  }, [page, filter]);

  const setF = (k: keyof typeof filter, v: string) => {
    setPage(0);
    setFilter(f => ({ ...f, [k]: v }));
  };

  if (loading && !data) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  const total = data?.total ?? 0;
  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Журнал действий</div>
            <div className="page-sub mono">
              // {total.toLocaleString('ru-RU')} записей · хранятся {data?.retentionDays ?? 90} дн.
            </div>
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}

        <div className="flex gap-8" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 'auto', minWidth: 160 }}
            value={filter.username} onChange={e => setF('username', e.target.value)}>
            <option value="">все пользователи</option>
            {data?.usernames.map(u => <option key={u} value={u}>{u}</option>)}
          </select>

          <select className="input" style={{ width: 'auto', minWidth: 200 }}
            value={filter.action} onChange={e => setF('action', e.target.value)}>
            <option value="">все действия</option>
            {data?.actions.map(a => <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>)}
          </select>

          <select className="input" style={{ width: 'auto', minWidth: 140 }}
            value={filter.status} onChange={e => setF('status', e.target.value)}>
            <option value="">любой результат</option>
            <option value="ok">выполнено</option>
            <option value="denied">отказано</option>
            <option value="failed">ошибка</option>
          </select>

          {(filter.username || filter.action || filter.status) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setPage(0); setFilter({ username: '', action: '', status: '' }); }}>
              ✕ сбросить
            </button>
          )}
        </div>

        {!data?.rows.length ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <div className="empty-text">
              {total === 0 && !filter.username && !filter.action && !filter.status
                ? 'Журнал пуст — действий пока не было.'
                : 'По этим фильтрам ничего не найдено.'}
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  {['Когда', 'Кто', 'Действие', 'Объект', 'IP', 'Результат'].map(h => (
                    <th key={h} style={{
                      textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid var(--border)',
                      fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => <Row key={r.id} row={r} />)}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between" style={{ marginTop: 16 }}>
            <button className="btn btn-outline btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              ← Назад
            </button>
            <span className="mono text-muted" style={{ fontSize: 11 }}>
              стр. {page + 1} из {pages}
            </span>
            <button className="btn btn-outline btn-sm" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>
              Вперёд →
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ row }: { row: AuditRecord }) {
  const when = new Date(row.ts * 1000);
  const label = ACTION_LABELS[row.action] ?? row.action;
  // Подробности показываем компактно: они нужны для разбора, но не должны
  // распирать таблицу.
  const details = row.details
    ? Object.entries(row.details)
        .filter(([, v]) => v !== null && v !== undefined && v !== false)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ')
    : '';

  const cell: React.CSSProperties = {
    padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, verticalAlign: 'top',
  };

  return (
    <tr>
      <td style={{ ...cell, whiteSpace: 'nowrap' }} className="mono text-muted">
        {when.toLocaleDateString('ru-RU')}<br />{when.toLocaleTimeString('ru-RU')}
      </td>
      <td style={cell}>
        {row.username}
        {row.role && <div className="mono text-muted" style={{ fontSize: 10 }}>{row.role}</div>}
      </td>
      <td style={cell}>
        {label}
        {details && <div className="mono text-muted" style={{ fontSize: 10, marginTop: 2 }}>{details}</div>}
      </td>
      <td style={cell}>
        {row.target_name ?? <span className="text-muted">—</span>}
        {row.target_type && row.target_name && (
          <div className="mono text-muted" style={{ fontSize: 10 }}>{row.target_type}</div>
        )}
      </td>
      <td style={cell} className="mono text-muted">{row.ip ?? '—'}</td>
      <td style={cell}>
        <span className={`badge badge-${row.status === 'ok' ? 'running' : 'stopped'}`}>
          {STATUS_LABELS[row.status]}
        </span>
      </td>
    </tr>
  );
}
