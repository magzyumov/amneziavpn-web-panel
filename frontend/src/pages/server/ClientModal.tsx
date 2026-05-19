import { useState, useEffect } from 'react';
import { clientsApi, downloadWithAuth, type ClientRecord, type ProtocolRecord } from '../../api';
import StatsTab from './StatsTab';

interface Props {
  client: ClientRecord;
  protocolType: ProtocolRecord['type'];
  onClose: () => void;
}

type Format = 'amnezia' | 'original';
type Tab = 'qr' | 'cfg' | 'stats';

const QR_AUTO_INTERVAL = 3000;

export default function ClientModal({ client, protocolType, onClose }: Props) {
  const [format, setFormat] = useState<Format>('amnezia');
  // Импортированные клиенты не имеют конфига — для них дефолтная вкладка stats.
  const [tab, setTab]       = useState<Tab>(client.has_config ? 'qr' : 'stats');

  const [origQr,         setOrigQr]         = useState<string | null>(null);
  const [amneziaQrParts, setAmneziaQrParts] = useState<string[] | null>(null);
  const [qrPartIdx,      setQrPartIdx]      = useState(0);
  const [vpnUri,         setVpnUri]         = useState('');
  const [origConf,       setOrigConf]       = useState('');
  const [loadingQr,      setLoadingQr]      = useState(true);

  const isXray = protocolType === 'xray';
  const hasAmnezia = protocolType === 'awg2' || protocolType === 'wireguard';
  const hasAmneziaQr = hasAmnezia || isXray;

  useEffect(() => {
    if (!client.has_config) { setLoadingQr(false); return; }
    setLoadingQr(true);
    clientsApi.qr(client.id).then(r => {
      setOrigQr(r.data.qr);
      setAmneziaQrParts(r.data.amneziaQrParts || (r.data.amneziaQr ? [r.data.amneziaQr] : null));
      setQrPartIdx(0);
      setVpnUri(r.data.vpnUri || '');
    }).catch(() => setOrigQr(null)).finally(() => setLoadingQr(false));

    clientsApi.configText(client.id).then(r => {
      setOrigConf(r.data.config || '');
      if (r.data.vpnUri) setVpnUri(r.data.vpnUri);
    });
  }, [client.id]);

  const showAmnezia  = hasAmneziaQr && format === 'amnezia';
  const totalParts   = amneziaQrParts?.length ?? 1;
  const autoActive   = showAmnezia && tab === 'qr' && totalParts > 1 && !loadingQr;

  useEffect(() => {
    if (!autoActive) return;
    const timer = setInterval(() => {
      setQrPartIdx(i => (i + 1) % totalParts);
    }, QR_AUTO_INTERVAL);
    return () => clearInterval(timer);
  }, [autoActive, totalParts, qrPartIdx]);

  const amneziaQr    = amneziaQrParts?.[qrPartIdx] ?? null;
  const activeQr     = showAmnezia ? amneziaQr : origQr;
  const activeHint   = showAmnezia
    ? (totalParts > 1
        ? `Часть ${qrPartIdx + 1} из ${totalParts} — сканируйте по очереди в AmneziaVPN`
        : 'Сканируйте в приложении AmneziaVPN')
    : isXray ? 'Сканируйте в FLClash, v2rayNG или совместимом клиенте'
             : 'Сканируйте в стандартном WireGuard клиенте';

  const activeDownloadUrl      = showAmnezia ? clientsApi.configAmneziaUrl(client.id) : clientsApi.configDownloadUrl(client.id);
  const activeDownloadLabel    = showAmnezia ? '⬇ JSON для Amnezia' : isXray ? '⬇ Скачать .txt' : '⬇ Скачать .conf';
  const activeDownloadFilename = showAmnezia
    ? `${client.name}_amnezia.json`
    : isXray ? `${client.name}.txt` : `${client.name}.conf`;

  // Stats доступна для всех трёх протоколов. Для Xray на старых установках
  // (без `stats` в server.json) бэкенд вернёт пустой series — StatsTab покажет
  // подсказку про "Enable stats" на ProtocolCard.
  const hasStats = (protocolType === 'awg2' || protocolType === 'wireguard' || protocolType === 'xray');
  const configTabs: Array<{ id: Tab; label: string }> = client.has_config ? [
    { id: 'qr',  label: 'QR-код' },
    { id: 'cfg', label: isXray ? 'VLESS URI' : format === 'amnezia' ? 'vpn:// URI' : '.conf' },
  ] : [];
  const tabs: Array<{ id: Tab; label: string }> = [
    ...configTabs,
    ...(hasStats ? [{ id: 'stats' as const, label: '📊 Stats' }] : []),
  ];

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 500 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div className="modal-title" style={{ margin: 0 }}>{client.name}</div>
            <div className="text-muted mono" style={{ fontSize: 11, marginTop: 4 }}>
              {protocolType?.toUpperCase()}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {!client.has_config && (
          <div className="notice notice-info" style={{ marginBottom: 16, fontSize: 12 }}>
            Этот клиент импортирован с сервера. Приватный ключ хранится только на устройстве клиента —
            конфиг и QR недоступны. Для переподключения создайте нового клиента.
          </div>
        )}

        {hasAmneziaQr && !!client.has_config && (
          <div style={{
            display: 'flex', gap: 0, marginBottom: 16,
            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
          }}>
            <button
              style={{
                flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
                background: format === 'amnezia' ? 'var(--accent)' : 'transparent',
                color: format === 'amnezia' ? '#fff' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer', transition: 'all .15s',
              }}
              onClick={() => setFormat('amnezia')}
            >
              📱 Для приложения Amnezia
            </button>
            <button
              style={{
                flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
                background: format === 'original' ? 'var(--accent)' : 'transparent',
                color: format === 'original' ? '#fff' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer', borderLeft: '1px solid var(--border)', transition: 'all .15s',
              }}
              onClick={() => setFormat('original')}
            >
              {isXray ? '📡 VLESS URI' : '📄 Оригинальный формат'}
            </button>
          </div>
        )}

        {/* Tab nav — рендерим всегда когда есть хоть одна вкладка
            (т.е. либо has_config, либо hasStats для импортированного клиента) */}
        {tabs.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {tabs.map(t => (
              <button key={t.id}
                className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        )}

        {tab === 'stats' && hasStats && <StatsTab clientId={client.id} />}

        {!!client.has_config && (<>
          {tab === 'qr' && (
            <div style={{ textAlign: 'center' }}>
              {loadingQr ? (
                <div style={{ padding: 60 }}><span className="spinner" style={{ width: 28, height: 28 }} /></div>
              ) : activeQr ? (
                <>
                  <img src={activeQr} alt="QR" style={{ width: 360, height: 360, borderRadius: 8 }} />

                  {showAmnezia && totalParts > 1 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                        {Array.from({ length: totalParts }).map((_, i) => (
                          <button key={i}
                            onClick={() => setQrPartIdx(i)}
                            style={{
                              width: 10, height: 10, borderRadius: '50%', border: 'none', cursor: 'pointer',
                              padding: 0,
                              background: i === qrPartIdx ? 'var(--accent)' : 'var(--border)',
                              transition: 'background 0.2s',
                            }}
                          />
                        ))}
                      </div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', margin: '0 auto', width: 360 }}>
                        <div key={`pb-${qrPartIdx}`} style={{
                          height: '100%', background: 'var(--accent)', borderRadius: 2,
                          animation: `qr-progress ${QR_AUTO_INTERVAL}ms linear`,
                        }} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8 }}>
                        <button className="btn btn-outline btn-sm"
                          onClick={() => setQrPartIdx(i => Math.max(0, i - 1))}
                          disabled={qrPartIdx === 0}>‹</button>
                        <span className="mono text-dim" style={{ fontSize: 11, minWidth: 48 }}>
                          {qrPartIdx + 1} / {totalParts}
                        </span>
                        <button className="btn btn-outline btn-sm"
                          onClick={() => setQrPartIdx(i => Math.min(totalParts - 1, i + 1))}
                          disabled={qrPartIdx === totalParts - 1}>›</button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="notice notice-error">Не удалось сгенерировать QR</div>
              )}
              <div className="text-muted" style={{ marginTop: 8, fontSize: 11 }}>{activeHint}</div>
            </div>
          )}

          {tab === 'cfg' && (
            <div>
              {showAmnezia ? (
                <>
                  <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 11 }}>
                    <b>vpn://</b> ссылка — вставьте или отсканируйте в AmneziaVPN (iOS / Android / Desktop)
                  </div>
                  <div className="config-box" style={{ fontSize: 10, wordBreak: 'break-all', maxHeight: 160, overflowY: 'auto' }}>
                    {vpnUri || 'Генерация…'}
                  </div>
                </>
              ) : (
                <>
                  {isXray && (
                    <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 11 }}>
                      VLESS URI — для FLClash, Clash Meta, v2rayNG
                    </div>
                  )}
                  <div className="config-box" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {origConf || 'Загрузка…'}
                  </div>
                </>
              )}
            </div>
          )}
        </>)}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-outline" onClick={onClose}>Закрыть</button>
          {!!client.has_config && (
            <button className="btn btn-primary" onClick={() => downloadWithAuth(activeDownloadUrl, activeDownloadFilename)}>
              {activeDownloadLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
