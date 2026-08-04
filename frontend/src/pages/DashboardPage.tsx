import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardApi, type DashboardSummary, type DayBucket } from '../api';
import { PROTOCOL_ICONS, PROTOCOL_NAMES } from '../protocols';
import { formatBytes, formatRelativeTime } from './server/format';

const REFRESH_MS = 30_000;

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => dashboardApi.summary()
      .then(r => { setData(r.data); setError(''); })
      .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить сводку'));
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (error && !data) return <div className="page-body"><div className="notice notice-error">{error}</div></div>;
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  const { servers, protocols, users, clients, traffic, subscriptions } = data;
  const todayTotal = traffic.today.rx + traffic.today.tx;
  const weekTotal = traffic.week.rx + traffic.week.tx;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Dashboard</div>
            <div className="page-sub mono">// обзор инфраструктуры</div>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Плитки: то, на что смотрят первым делом */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          <Tile label="Серверы" value={servers.length}
            sub={servers.some(s => s.stale) ? '⚠ есть не отвечающие' : 'все отвечают'}
            warn={servers.some(s => s.stale)} />
          <Tile label="Протоколы" value={`${protocols.running} / ${protocols.total}`}
            sub="запущено / всего" warn={protocols.running < protocols.total} />
          <Tile label="Клиенты" value={clients.total}
            sub={`${clients.online} онлайн сейчас`} accent={clients.online > 0} />
          <Tile label="Пользователи" value={users.total}
            sub={`${users.admins} admin · ${users.regular} user`} />
          <Tile label="Трафик сегодня" value={formatBytes(todayTotal)}
            sub={`за неделю ${formatBytes(weekTotal)}`} />
          <Tile label="Подписки" value={subscriptions} sub="Clash / FLClash" />
        </div>

        {/* Предупреждения — только когда есть о чём. Пустых блоков не рисуем. */}
        <Alerts clients={clients} servers={servers} />

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <div className="card">
            <div className="input-label" style={{ marginBottom: 12 }}>Трафик за 14 дней</div>
            <TrafficChart daily={traffic.daily} />
          </div>

          <div className="card">
            <div className="input-label" style={{ marginBottom: 12 }}>Протоколы</div>
            {protocols.byType.length === 0 ? (
              <div className="text-muted mono" style={{ fontSize: 11 }}>Ни одного протокола не установлено</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {protocols.byType.map(p => (
                  <div key={p.type} className="flex items-center justify-between" style={{ gap: 8 }}>
                    <span style={{ fontSize: 13 }}>
                      {PROTOCOL_ICONS[p.type]} {PROTOCOL_NAMES[p.type]}
                    </span>
                    <span className="mono text-muted" style={{ fontSize: 11 }}>
                      {p.count} шт · {p.clients} клиентов
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <div className="card">
            <div className="input-label" style={{ marginBottom: 12 }}>Серверы</div>
            {servers.length === 0 ? (
              <div className="text-muted mono" style={{ fontSize: 11 }}>
                Серверов пока нет. <Link to="/servers">Добавить</Link>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {servers.map(s => (
                  <Link key={s.id} to={`/server/${s.id}`}
                    className="flex items-center justify-between"
                    style={{ gap: 8, textDecoration: 'none', color: 'inherit' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                      <div className="mono text-muted" style={{ fontSize: 11 }}>{s.host}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <span className={`badge badge-${s.stale ? 'stopped' : 'running'}`}>
                        {s.stale ? 'не отвечает' : `${s.running}/${s.protocols}`}
                      </span>
                      <div className="mono text-muted" style={{ fontSize: 10, marginTop: 2 }}>
                        {s.lastPollAt ? formatRelativeTime(s.lastPollAt) : 'опроса не было'}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="input-label" style={{ marginBottom: 12 }}>Топ клиентов за 14 дней</div>
            {traffic.topClients.length === 0 ? (
              <div className="text-muted mono" style={{ fontSize: 11 }}>Трафика пока не было</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {traffic.topClients.map(c => (
                  <div key={c.id} className="flex items-center justify-between" style={{ gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{PROTOCOL_ICONS[c.type]} {c.name}</div>
                      <div className="mono text-muted" style={{ fontSize: 10 }}>
                        {c.owner ?? 'без владельца'}
                      </div>
                    </div>
                    <span className="mono" style={{ fontSize: 12, flexShrink: 0 }}>{formatBytes(c.rx + c.tx)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Плитка ───────────────────────────────────────────────────────────────────

interface TileProps { label: string; value: string | number; sub?: string; warn?: boolean; accent?: boolean }

function Tile({ label, value, sub, warn, accent }: TileProps) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="mono text-muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontSize: 24, fontWeight: 700, marginTop: 4, lineHeight: 1.1,
        color: warn ? 'var(--danger, #e5534b)' : accent ? 'var(--accent)' : undefined,
      }}>{value}</div>
      {sub && <div className="mono text-muted" style={{ fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Предупреждения ───────────────────────────────────────────────────────────

function Alerts({ clients, servers }: Pick<DashboardSummary, 'clients' | 'servers'>) {
  const items = [
    servers.filter(s => s.stale).length > 0
      ? `${servers.filter(s => s.stale).length} серв. числятся запущенными, но не отвечают на опрос статистики`
      : null,
    clients.suspended > 0
      ? `${clients.suspended} клиентов приостановлены по суточному лимиту — вернутся сами с началом новых суток`
      : null,
    clients.expiringSoon > 0
      ? `${clients.expiringSoon} клиентов истекают в ближайшие сутки и будут удалены`
      : null,
    clients.orphaned > 0
      ? `${clients.orphaned} клиентов без владельца (импортированы или остались от удалённых пользователей)`
      : null,
  ].filter(Boolean) as string[];

  if (items.length === 0) return null;

  return (
    <div className="notice" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(t => <div key={t} style={{ fontSize: 12 }}>· {t}</div>)}
    </div>
  );
}

// ─── График ───────────────────────────────────────────────────────────────────

// Столбики по суткам: rx снизу, tx сверху. Свой SVG, а не библиотека графиков —
// одна диаграмма не стоит зависимости, а CSP запрещает внешние скрипты.
function TrafficChart({ daily }: { daily: DayBucket[] }) {
  const max = Math.max(1, ...daily.map(d => d.rx + d.tx));
  const W = 100, H = 40, gap = 1.2;
  const barW = (W - gap * (daily.length - 1)) / daily.length;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block' }}>
        {daily.map((d, i) => {
          const total = d.rx + d.tx;
          const h = (total / max) * H;
          const rxH = total > 0 ? (d.rx / total) * h : 0;
          const x = i * (barW + gap);
          return (
            <g key={d.day}>
              <title>{`${d.day}: ↓ ${formatBytes(d.rx)} · ↑ ${formatBytes(d.tx)}`}</title>
              <rect x={x} y={H - h} width={barW} height={rxH} fill="var(--accent)" opacity={0.85} />
              <rect x={x} y={H - h + rxH} width={barW} height={Math.max(0, h - rxH)} fill="var(--accent)" opacity={0.4} />
              {/* Прозрачная накладка на всю высоту — иначе подсказка не ловится у низких столбиков */}
              <rect x={x} y={0} width={barW} height={H} fill="transparent" />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between mono text-muted" style={{ fontSize: 10, marginTop: 6 }}>
        <span>{daily[0]?.day.slice(5)}</span>
        <span>макс. за сутки: {formatBytes(max)}</span>
        <span>сегодня</span>
      </div>
    </div>
  );
}
