import { useState, useEffect } from 'react';
import { protocolsApi } from '../../api';

type ProtocolType = 'awg2' | 'wireguard' | 'xray' | 'mtproxy' | 'telemt';

interface Props {
  serverId: string;
  onClose: () => void;
  onInstalled: (data: any) => void;
}

const DEFAULTS: Record<ProtocolType, Record<string, any>> = {
  awg2:      { port: '', jc: 6, jmin: 10, jmax: 50, s1: 143, s2: 122, s3: 59, s4: 17 },
  xray:      { port: 443, sni: 'www.googletagmanager.com' },
  wireguard: { port: '' },
  mtproxy:   { port: '', tlsDomain: 'www.google.com' },
  telemt:    { port: '', tlsDomain: 'www.google.com' },
};

export default function InstallProtocolModal({ serverId, onClose, onInstalled }: Props) {
  const [type, setType] = useState<ProtocolType>('awg2');
  const [opts, setOpts] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');

  const set = (k: string, v: any) => setOpts(o => ({ ...o, [k]: v }));

  useEffect(() => { setOpts(DEFAULTS[type] || {}); }, [type]);

  const install = async () => {
    setLoading(true);
    setError('');
    setLog(`► Installing ${type}...\n► Pulling Docker image (может занять минуту)...\n`);
    try {
      const options: Record<string, any> = { ...opts };
      if (!options.port) delete options.port;
      const r = await protocolsApi.install(serverId, { type, options });
      setLog(l => l + `\n✓ Done!\n  Container: ${r.data.containerName}\n  Port: ${r.data.port}\n`);
      setTimeout(() => { onInstalled(r.data); }, 1200);
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message;
      setError(msg);
      setLog(l => l + `\n✗ Error: ${msg}\n`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !loading && onClose()}>
      <div className="modal" style={{ width: 540 }}>
        <div className="modal-title">Install Protocol</div>

        <div className="input-group" style={{ marginBottom: 16 }}>
          <label className="input-label">Protocol</label>
          <select className="input" value={type} onChange={e => setType(e.target.value as ProtocolType)}>
            <option value="awg2">🛡️ AmneziaWG 2.0</option>
            <option value="xray">⚡ Xray VLESS Reality</option>
            <option value="wireguard">🔒 WireGuard</option>
            <option value="mtproxy">✈️ MTProxy (Telegram)</option>
            <option value="telemt">📨 Telemt (Telegram)</option>
          </select>
        </div>

        {type === 'awg2' && (
          <div>
            <div className="notice notice-info" style={{ marginBottom: 12, fontSize: 11 }}>
              Порт и параметры H1-H4 генерируются автоматически если не заданы
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { k: 'port',  label: 'UDP Port (пусто = random)' },
                { k: 'jc',   label: 'Jc (junk count, 3-10)' },
                { k: 'jmin', label: 'Jmin' },
                { k: 'jmax', label: 'Jmax' },
                { k: 's1',   label: 'S1' },
                { k: 's2',   label: 'S2' },
                { k: 's3',   label: 'S3' },
                { k: 's4',   label: 'S4' },
              ].map(f => (
                <div key={f.k} className="input-group">
                  <label className="input-label">{f.label}</label>
                  <input className="input input-mono" type="number"
                    value={opts[f.k] ?? ''} placeholder="auto"
                    onChange={e => set(f.k, e.target.value === '' ? '' : +e.target.value)} />
                </div>
              ))}
            </div>
          </div>
        )}

        {type === 'xray' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="input-group">
              <label className="input-label">Port</label>
              <input className="input input-mono" type="number" value={opts.port ?? 443}
                onChange={e => set('port', +e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">SNI — Reality target domain</label>
              <input className="input input-mono" value={opts.sni ?? ''}
                onChange={e => set('sni', e.target.value)} />
            </div>
            <div className="notice notice-info" style={{ fontSize: 11 }}>
              Reality ключи генерируются автоматически через xray x25519
            </div>
          </div>
        )}

        {type === 'wireguard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="input-group">
              <label className="input-label">UDP Port (пусто = random)</label>
              <input className="input input-mono" type="number" placeholder="auto"
                value={opts.port ?? ''} onChange={e => set('port', e.target.value === '' ? '' : +e.target.value)} />
            </div>
          </div>
        )}

        {(type === 'mtproxy' || type === 'telemt') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="notice notice-info" style={{ fontSize: 11 }}>
              {type === 'telemt'
                ? 'Telegram-прокси с FakeTLS-маскировкой. Проксирует только трафик Telegram. Каждый клиент — отдельный секрет с tg:// ссылкой.'
                : 'Официальный MTProto-прокси Telegram. Проксирует только трафик Telegram. Каждый клиент — отдельный секрет с tg:// ссылкой.'}
            </div>
            <div className="input-group">
              <label className="input-label">TCP Port (пусто = random)</label>
              <input className="input input-mono" type="number" placeholder="auto"
                value={opts.port ?? ''} onChange={e => set('port', e.target.value === '' ? '' : +e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">
                FakeTLS домен {type === 'mtproxy' ? '(пусто = secure mode)' : '(обязателен)'}
              </label>
              <input className="input input-mono" placeholder="www.google.com"
                value={opts.tlsDomain ?? ''} onChange={e => set('tlsDomain', e.target.value)} />
            </div>
          </div>
        )}

        {log && <div className="terminal" style={{ marginTop: 16 }}>{log}</div>}
        {error && <div className="notice notice-error" style={{ marginTop: 12 }}>{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn btn-primary" onClick={install} disabled={loading}>
            {loading ? <><span className="spinner" /> Installing…</> : '▶ Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
