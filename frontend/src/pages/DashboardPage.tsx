import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { dashboardApi, type DashboardSummary, type DayBucket, type ServerSummary } from '../api';
import { PROTOCOL_ICONS, PROTOCOL_NAMES } from '../protocols';
import { formatBytes, formatRelativeTime } from './server/format';

const REFRESH_MS = 30_000;

// Метрики хоста снимаются только вручную. Старее этого срока показывать их как
// действующие нельзя: диск «95%» может быть давно почищен, а красная плашка
// продолжала бы кричать — интерфейс уверенно показывал бы неверное.
const METRICS_FRESH_SEC = 6 * 3600;

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState('');
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const load = () => dashboardApi.summary()
      .then(r => { setData(r.data); setError(''); })
      .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить сводку'));
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const probe = async () => {
    setProbing(true);
    setError('');
    try {
      const r = await dashboardApi.probe();
      setData(r.data.summary);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось опросить серверы');
    } finally {
      setProbing(false);
    }
  };

  if (error && !data) return <div className="page-body"><div className="notice notice-error">{error}</div></div>;
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>;

  const { servers, protocols, users, clients, traffic, subscriptions, storage } = data;
  const todayTotal = traffic.today.rx + traffic.today.tx;
  const weekTotal = traffic.week.rx + traffic.week.tx;
  const maxDay = Math.max(0, ...traffic.daily.map(d => d.rx + d.tx));

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Сводка</div>
            <div className="page-sub mono">// обзор инфраструктуры</div>
          </div>
          <div className="flex gap-8 page-header-actions">
            <button className="btn btn-outline" onClick={probe} disabled={probing}
              title="Зайти по SSH на каждый сервер и снять аптайм, нагрузку, память, диск и статус AmneziaDNS">
              {probing ? <><span className="spinner" /> Опрашиваю…</> : '⟳ Опросить серверы'}
            </button>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && <div className="notice notice-error">{error}</div>}

        {/* Плитки: то, на что смотрят первым делом. Ведут туда, где этим управляют. */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, alignItems: 'start' }}>
          <Tile label="Серверы" title="Перейти к списку серверов" value={servers.length} to="/servers"
            sub={servers.some(s => s.stale) ? '⚠ есть не отвечающие' : 'все отвечают'}
            warn={servers.some(s => s.stale)} />
          <Tile label="Протоколы" title="Запущенные и всего установленные VPN-протоколы. Открыть список серверов"
            value={`${protocols.running} / ${protocols.total}`} to="/servers"
            sub="запущено / всего" warn={protocols.running < protocols.total} />
          <Tile label="Клиенты" value={clients.total}
            sub={`${clients.online} онлайн · ${clients.activeToday} за сутки`}
            accent={clients.online > 0} />
          <Tile label="Пользователи" title="Учётные записи панели. Открыть управление пользователями"
            value={users.total} to="/users"
            sub={`${users.admins} admin · ${users.regular} user`} />
          <Tile label="Трафик сегодня" value={formatBytes(todayTotal)}
            sub={`за неделю ${formatBytes(weekTotal)}`} />
          <Tile label="Подписки" value={subscriptions} to="/subscriptions" sub="Clash / FLClash"
            title="Выданные ссылки-подписки. Открыть управление подписками" />
          {/* Хранилище — тоже показатель состояния, и в общем ряду оно перестаёт
              висеть отдельной строкой в подвале. Дата первого снимка убрана в
              подсказку: в плитке важна не она, а что ретеншен работает. */}
          <Tile label="Хранилище" value={formatBytes(storage.dbBytes)}
            sub={`${storage.statsRows.toLocaleString('ru-RU')} снимков · ${storage.retentionDays} дн.`}
            title={storage.oldestSnapshotAt
              ? `Снимки статистики с ${new Date(storage.oldestSnapshotAt * 1000).toLocaleDateString('ru-RU')}, хранятся ${storage.retentionDays} дней`
              : 'Снимков статистики пока нет'} />
        </div>

        <Alerts data={data} />

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
          <div className="card">
            <div className="flex items-center justify-between" style={{ marginBottom: 12, gap: 8 }}>
              <span className="input-label" style={{ margin: 0 }}>Трафик за 14 дней</span>
              <span className="mono text-muted" style={{ fontSize: 10 }}>макс. за сутки: {formatBytes(maxDay)}</span>
            </div>
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

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
          <div className="card">
            <div className="input-label" style={{ marginBottom: 12 }}>Серверы</div>
            {servers.length === 0 ? (
              <div className="text-muted mono" style={{ fontSize: 11 }}>
                Серверов пока нет. <Link to="/servers">Добавить</Link>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {servers.map(s => <ServerRow key={s.id} server={s} />)}
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

// ─── Строка сервера ───────────────────────────────────────────────────────────

function formatUptime(sec: number | null): string {
  if (!sec) return '—';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return days > 0 ? `${days} дн. ${hours} ч` : `${hours} ч`;
}

function ServerRow({ server: s }: { server: ServerSummary }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const hasMetrics = s.probedAt !== null && !s.probeError;
  // Замер старше нескольких часов — справка, а не показание: гасим цвет и
  // говорим прямо, что данные устарели.
  const fresh = hasMetrics && s.probedAt !== null && nowSec - s.probedAt < METRICS_FRESH_SEC;

  const diskUsedPct = s.diskTotalMb && s.diskFreeMb !== null
    ? Math.round(((s.diskTotalMb - s.diskFreeMb) / s.diskTotalMb) * 100)
    : null;
  const memUsedPct = s.memTotalMb && s.memUsedMb !== null
    ? Math.round((s.memUsedMb / s.memTotalMb) * 100)
    : null;

  // Красным подсвечиваем только свежее: устаревший красный «диск 95%» опаснее
  // отсутствия цифры вовсе.
  const alarm = (pct: number | null) =>
    fresh && pct !== null && pct >= 90 ? 'var(--danger, #e5534b)' : undefined;
  const dim: React.CSSProperties = fresh ? {} : { opacity: 0.55 };

  return (
    <div>
      <Link to={`/server/${s.id}`} className="flex items-center justify-between"
        title={`Открыть ${s.name}: протоколы, клиенты и статистика`}
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

      <div className="mono text-muted" style={{ fontSize: 10, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: s.dnsInstalled === false ? 'var(--danger, #e5534b)' : undefined }}
          title="AmneziaDNS — серверный резолвер, защита от DNS-leak">
          🛡️ DNS: {s.dnsInstalled === null ? 'неизвестно' : s.dnsInstalled ? 'есть' : 'нет'}
        </span>
        {s.probeError ? (
          <span style={{ color: 'var(--danger, #e5534b)' }} title={s.probeError}>⚠ опрос не удался</span>
        ) : hasMetrics ? (
          <>
            <span style={dim}>⏱ {formatUptime(s.uptimeSec)}</span>
            {s.load1 !== null && <span style={dim}>load {s.load1.toFixed(2)}</span>}
            {memUsedPct !== null && <span style={{ ...dim, color: alarm(memUsedPct) }}>RAM {memUsedPct}%</span>}
            {diskUsedPct !== null && (
              <span style={{ ...dim, color: alarm(diskUsedPct) }}>
                диск {diskUsedPct}% ({formatBytes((s.diskFreeMb ?? 0) * 1024 * 1024)} свободно)
              </span>
            )}
            {fresh
              ? <span style={dim}>· снято {formatRelativeTime(s.probedAt)}</span>
              : <span title="Метрики снимаются только по кнопке «Опросить серверы»">
                  · данные от {formatRelativeTime(s.probedAt)} — устарели, опросите заново
                </span>}
          </>
        ) : (
          <span>метрик нет — нажмите «Опросить серверы»</span>
        )}
      </div>
    </div>
  );
}

// ─── Плитка ───────────────────────────────────────────────────────────────────

interface TileProps {
  label: string; value: string | number; sub?: string;
  warn?: boolean; accent?: boolean;
  /** Куда ведёт плитка. Без него — просто цифра. */
  to?: string;
  /** Подробность, которой не место в двух строках плитки. */
  title?: string;
}

function Tile({ label, value, sub, warn, accent, to, title }: TileProps) {
  const body = (
    <div className="card" style={{ padding: 14, height: '100%' }} title={title}>
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
  if (!to) return body;
  return <Link to={to} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{body}</Link>;
}

// ─── Предупреждения ───────────────────────────────────────────────────────────

// Блок рисуется только когда есть о чём: пустая «всё хорошо» карточка занимает
// место и приучает не читать это место вовсе.
function Alerts({ data }: { data: DashboardSummary }) {
  const { clients, servers, issues } = data;
  const stale = servers.filter(s => s.stale);
  const noDns = servers.filter(s => s.dnsInstalled === false);

  const items: string[] = [
    stale.length > 0
      ? `${stale.length} серв. числятся запущенными, но не отвечают на опрос статистики: ${stale.map(s => s.name).join(', ')}`
      : '',
    issues.silent.length > 0
      ? `${issues.silent.length} протоколов работают, но не отдают статистику (${issues.silent.map(p => `${p.type} на ${p.serverName}`).join(', ')}). У Xray это обычно выключенный stats API — без него не сработает и суточный лимит трафика`
      : '',
    issues.drifted.length > 0
      ? `${issues.drifted.length} протоколов собраны не по текущему коду (${issues.drifted.map(p => `${p.type} на ${p.serverName}`).join(', ')}) — переустановите, чтобы применить изменения`
      : '',
    noDns.length > 0
      ? `На ${noDns.length} серв. не установлен AmneziaDNS (${noDns.map(s => s.name).join(', ')}) — клиенты WG/AWG ходят на публичный DNS`
      : '',
    clients.suspended > 0
      ? `${clients.suspended} клиентов приостановлены по суточному лимиту — вернутся сами с началом новых суток`
      : '',
    clients.expiringSoon > 0
      ? `${clients.expiringSoon} клиентов истекают в ближайшие сутки и будут удалены`
      : '',
    clients.orphaned > 0
      ? `${clients.orphaned} клиентов без владельца (импортированы или остались от удалённых пользователей)`
      : '',
  ].filter(Boolean);

  if (items.length === 0) return null;

  return (
    <div className="notice" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(t => <div key={t} style={{ fontSize: 12 }}>· {t}</div>)}
    </div>
  );
}

// ─── График ───────────────────────────────────────────────────────────────────

// Столбики по суткам: принято снизу, отправлено сверху. Свой SVG, а не
// библиотека графиков — одна диаграмма не стоит зависимости, а CSP панели всё
// равно запрещает внешние скрипты.
function TrafficChart({ daily }: { daily: DayBucket[] }) {
  const max = Math.max(1, ...daily.map(d => d.rx + d.tx));
  const W = 100, H = 40, gap = 1.2;
  const barW = (W - gap * (daily.length - 1)) / daily.length;

  // Подписи под каждым вторым столбцом: под каждым они наезжают друг на друга
  // при четырнадцати сутках, а без них непонятно, какой столбец какой день.
  const label = (day: string, i: number) => {
    if (i === daily.length - 1) return 'сег.';
    return i % 2 === 0 ? day.slice(8) + '.' + day.slice(5, 7) : '';
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block' }}>
        {/* Линия максимума — иначе у столбиков нет никакого масштаба */}
        <line x1={0} y1={0.4} x2={W} y2={0.4} stroke="var(--border)" strokeWidth={0.3} strokeDasharray="1 1.5" />
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

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${daily.length}, 1fr)`, marginTop: 4 }}>
        {daily.map((d, i) => (
          <span key={d.day} className="mono text-muted"
            style={{ fontSize: 9, textAlign: 'center', whiteSpace: 'nowrap' }}>
            {label(d.day, i)}
          </span>
        ))}
      </div>

      {/* Разница 0.85/0.4 хорошо видна на столбцах, но на восьмипиксельных
          квадратиках легенды сливалась — здесь контраст выше. */}
      <div className="flex gap-8 mono text-muted" style={{ fontSize: 10, marginTop: 8 }}>
        <span><Swatch opacity={1} /> принято</span>
        <span><Swatch opacity={0.3} /> отправлено</span>
      </div>
    </div>
  );
}

function Swatch({ opacity }: { opacity: number }): ReactNode {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: 2,
      background: 'var(--accent)', opacity, marginRight: 4, verticalAlign: 'middle',
    }} />
  );
}
