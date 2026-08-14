import { useEffect, useState } from 'react';
import { diskApi, serversApi, type DiskReport, type DiskReportItem, type ServerRecord } from '../api';
import { formatBytes } from './server/format';

// Место на диске. Каждый пункт списка чистится своей командой, поэтому и кнопка
// у каждого своя: одной «очистить всё» не выйдет — цена ошибки у пунктов разная.
export default function DiskPage() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [serverId, setServerId] = useState('');
  const [report, setReport] = useState<DiskReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    serversApi.list()
      .then(r => { setServers(r.data); setServerId(prev => prev || r.data[0]?.id || ''); })
      .catch(e => setError(e.response?.data?.error || 'Не удалось загрузить список серверов'));
  }, []);

  const load = async (id = serverId) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const r = await diskApi.report(id);
      setReport(r.data);
    } catch (e: any) {
      setReport(null);
      setError(e.response?.data?.error || 'Не удалось считать размеры');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (serverId) load(serverId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  const clean = async (item: DiskReportItem) => {
    if (!window.confirm(
      `Очистить «${item.label}» (${formatBytes(item.bytes)})?\n\n${item.hint}\n\nБудет выполнено на сервере:\nsudo ${item.cleanCmd}`,
    )) return;
    setBusy(item.id);
    setError('');
    setNote('');
    try {
      const r = await diskApi.clean(serverId, item.id);
      const freed = item.bytes - (r.data.items.find(i => i.id === item.id)?.bytes ?? 0);
      setReport(r.data);
      setNote(`${item.label}: освобождено ${formatBytes(Math.max(0, freed))}`);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Очистка не удалась');
    } finally {
      setBusy('');
    }
  };

  const usedPct = report && report.usage.total
    ? Math.round((report.usage.used / report.usage.total) * 100)
    : 0;
  const reclaimable = report ? report.items.reduce((s, i) => s + i.bytes, 0) : 0;
  const barColor = usedPct >= 90 ? 'var(--danger, #e5534b)' : usedPct >= 75 ? '#e3b341' : 'var(--accent)';

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Диск</div>
            <div className="page-sub mono">// что занимает место и чем это чистить</div>
          </div>
          <div className="flex gap-8 page-header-actions">
            {servers.length > 1 && (
              <select className="input" value={serverId} onChange={e => setServerId(e.target.value)}
                style={{ width: 'auto' }}>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.host})</option>)}
              </select>
            )}
            <button className="btn btn-outline" onClick={() => load()} disabled={loading || !serverId}
              title="Пересчитать размеры по SSH">
              {loading ? <><span className="spinner" /> Считаю…</> : '⟳ Обновить'}
            </button>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && <div className="notice notice-error">{error}</div>}
        {note && <div className="notice">{note}</div>}
        {!serverId && !error && <div className="text-muted mono" style={{ fontSize: 12 }}>Сначала добавьте сервер.</div>}

        {report && (
          <>
            <div className="card">
              <div className="flex items-center justify-between" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <span className="input-label" style={{ margin: 0 }}>Корневой раздел</span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {formatBytes(report.usage.used)} / {formatBytes(report.usage.total)} ·{' '}
                  <span style={{ color: barColor }}>{formatBytes(report.usage.avail)} свободно ({usedPct}%)</span>
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elevated, #222)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, usedPct)}%`, height: '100%', background: barColor }} />
              </div>
              <div className="mono text-muted" style={{ fontSize: 11, marginTop: 8 }}>
                можно освободить примерно {formatBytes(reclaimable)}
              </div>
            </div>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {report.items.map(item => (
                <div key={item.id} className="flex items-center justify-between"
                  style={{ gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border, #2a2a2a)', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 260px' }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</div>
                    <div className="mono text-muted" style={{ fontSize: 11 }}>{item.hint}</div>
                    {/* Команда видна до нажатия: кнопка выполняет её под sudo на боевом VPS. */}
                    <div className="mono" style={{
                      fontSize: 11, marginTop: 4, color: 'var(--text-dim)',
                      overflowX: 'auto', whiteSpace: 'nowrap',
                    }} title="Выполнится по SSH под sudo">
                      $ sudo {item.cleanCmd}
                    </div>
                  </div>
                  <div className="flex items-center gap-8" style={{ flexShrink: 0 }}>
                    <span className="mono" style={{ fontSize: 13, minWidth: 80, textAlign: 'right',
                      color: item.bytes === 0 ? 'var(--text-muted, #777)' : undefined }}>
                      {formatBytes(item.bytes)}
                    </span>
                    <button className="btn btn-outline btn-sm" disabled={!!busy || item.bytes === 0}
                      onClick={() => clean(item)}>
                      {busy === item.id ? <><span className="spinner" /> Чищу…</> : 'Очистить'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
