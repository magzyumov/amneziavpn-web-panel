import { useEffect, useState } from 'react';
import { clientsApi, type ClientStatsResponse, type ProtocolRecord, type StatsRange } from '../../api';
import { formatBytes, formatBitsPerSec, formatRelativeTime } from './format';
import Sparkline from './Sparkline';

interface Props {
  clientId: string;
  protocolType?: ProtocolRecord['type'];
}

const RANGES: Array<{ id: StatsRange; label: string }> = [
  { id: '1h',  label: '1 час' },
  { id: '24h', label: '24 ч' },
  { id: '7d',  label: '7 дней' },
  { id: '30d', label: '30 дней' },
];

export default function StatsTab({ clientId, protocolType }: Props) {
  // Telemt отдаёт только суммарный трафик (total_octets в rxBytes, tx=0) и
  // "онлайн" по числу активных соединений, а не handshake.
  const combinedTraffic = protocolType === 'telemt';
  const [range, setRange] = useState<StatsRange>('24h');
  const [data, setData]   = useState<ClientStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    clientsApi.stats(clientId, range)
      .then(r => setData(r.data))
      .catch(e => setError(e?.response?.data?.error || e?.message || 'Failed to load stats'))
      .finally(() => setLoading(false));
  }, [clientId, range]);

  // Peak rate в окне — для подписи под графиком
  const peakRx = data?.series.length ? Math.max(...data.series.map(s => s.rxRate)) : 0;
  const peakTx = data?.series.length ? Math.max(...data.series.map(s => s.txRate)) : 0;

  return (
    <div>
      {/* Online + Last seen */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: data?.online ? '#3fb950' : 'var(--text-dim)',
            boxShadow: data?.online ? '0 0 6px #3fb950' : 'none',
          }} />
          {data?.online ? <b style={{ color: '#3fb950' }}>online</b> : <span className="text-muted">offline</span>}
        </span>
        <span className="text-muted mono" style={{ fontSize: 11 }}>
          {combinedTraffic ? 'последняя активность' : 'last handshake'}: {formatRelativeTime(data?.lastHandshake ?? null)}
        </span>
      </div>

      {/* Total traffic — обнуляется при рестарте контейнера, поэтому называем
          "С момента старта контейнера", не "за всё время" */}
      {combinedTraffic ? (
        <div style={{ marginBottom: 16 }}>
          <div className="card" style={{ padding: 12 }}>
            <div className="text-muted mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              ⇅ Трафик (всего)
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2, color: '#3fb950' }}>
              {formatBytes(data?.totalRx ?? 0)}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          <div className="card" style={{ padding: 12 }}>
            <div className="text-muted mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              ↓ Принято (rx)
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2, color: '#3fb950' }}>
              {formatBytes(data?.totalRx ?? 0)}
            </div>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <div className="text-muted mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              ↑ Отправлено (tx)
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2, color: '#f0883e' }}>
              {formatBytes(data?.totalTx ?? 0)}
            </div>
          </div>
        </div>
      )}

      {/* Range tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {RANGES.map(r => (
          <button key={r.id}
            className={`btn btn-sm ${range === r.id ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setRange(r.id)}>{r.label}</button>
        ))}
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <span className="spinner" style={{ width: 20, height: 20 }} />
        </div>
      ) : (
        <>
          <Sparkline data={data?.series ?? []} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11 }}>
            {combinedTraffic ? (
              <span className="mono" style={{ color: '#3fb950' }}>● пик трафика: {formatBitsPerSec(peakRx)}</span>
            ) : (
              <>
                <span className="mono" style={{ color: '#3fb950' }}>● rx peak: {formatBitsPerSec(peakRx)}</span>
                <span className="mono" style={{ color: '#f0883e' }}>● tx peak: {formatBitsPerSec(peakTx)}</span>
              </>
            )}
          </div>
        </>
      )}

      <div className="text-muted mono" style={{ fontSize: 10, marginTop: 12, lineHeight: 1.5 }}>
        Снимки собираются раз в минуту фоновым воркером. Total rx/tx сбрасываются при рестарте VPN-контейнера.
      </div>
    </div>
  );
}
