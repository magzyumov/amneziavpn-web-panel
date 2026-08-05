// Поля параметров Xray. Используются и при установке протокола, и при
// последующем редактировании — правила совместимости в обоих местах одни и те же,
// поэтому разметка живёт в одном компоненте.
//
// Совместимость (её же проверяет backend в normalizeXraySettings):
//  - flow=xtls-rprx-vision работает только при security=reality + transport=tcp;
//  - SNI и fingerprint имеют смысл только при security=reality;
//  - поля XHTTP появляются только при transport=xhttp.

export const XRAY_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];

export interface XrayOpts {
  sni?: string;
  security?: string;
  fingerprint?: string;
  flow?: string;
  transport?: string;
  xhttpHost?: string;
  xhttpPath?: string;
  xhttpMode?: string;
}

interface Props {
  opts: XrayOpts;
  set: (key: string, value: any) => void;
}

export default function XrayOptionFields({ opts, set }: Props) {
  const security = opts.security ?? 'reality';
  const transport = opts.transport ?? 'tcp';
  const flowAvailable = security === 'reality' && transport === 'tcp';

  return (
    <>
      <div className="input-group">
        <label className="input-label">Security</label>
        <select className="input" value={security} onChange={e => set('security', e.target.value)}>
          <option value="reality">Reality — маскировка под чужой TLS-сайт</option>
          <option value="none">None — без TLS (трафик не шифруется)</option>
        </select>
        {security === 'none' && (
          <div className="notice notice-info" style={{ fontSize: 11, marginTop: 6 }}>
            Без TLS трафик и адреса назначения идут открытым текстом. Помогает там,
            где провайдер режет TLS по SNI, но приватности не даёт.
          </div>
        )}
      </div>

      {security === 'reality' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="input-group">
            <label className="input-label">SNI — домен маскировки</label>
            <input className="input input-mono" placeholder="www.googletagmanager.com"
              value={opts.sni ?? ''} onChange={e => set('sni', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Fingerprint</label>
            <select className="input" value={opts.fingerprint ?? 'chrome'}
              onChange={e => set('fingerprint', e.target.value)}>
              {XRAY_FINGERPRINTS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="input-group">
          <label className="input-label">Transport</label>
          <select className="input" value={transport} onChange={e => set('transport', e.target.value)}>
            <option value="tcp">TCP / raw</option>
            <option value="xhttp">XHTTP / SplitHTTP</option>
          </select>
        </div>
        <div className="input-group">
          <label className="input-label">Flow</label>
          <select className="input" value={flowAvailable ? (opts.flow ?? 'xtls-rprx-vision') : ''}
            disabled={!flowAvailable} onChange={e => set('flow', e.target.value)}>
            <option value="">пусто — без Vision</option>
            <option value="xtls-rprx-vision">xtls-rprx-vision</option>
          </select>
          {!flowAvailable && (
            <div className="notice notice-info" style={{ fontSize: 11, marginTop: 6 }}>
              Vision доступен только с Reality на транспорте TCP
            </div>
          )}
        </div>
      </div>

      {transport === 'xhttp' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div className="input-group">
            <label className="input-label">XHTTP Host</label>
            <input className="input input-mono" placeholder={opts.sni || 'www.googletagmanager.com'}
              value={opts.xhttpHost ?? ''} onChange={e => set('xhttpHost', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">XHTTP Path</label>
            <input className="input input-mono" placeholder="/"
              value={opts.xhttpPath ?? ''} onChange={e => set('xhttpPath', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">XHTTP Mode</label>
            <select className="input" value={opts.xhttpMode ?? 'auto'}
              onChange={e => set('xhttpMode', e.target.value)}>
              <option value="auto">auto</option>
              <option value="packet-up">packet-up</option>
              <option value="stream-up">stream-up</option>
              <option value="stream-one">stream-one</option>
            </select>
          </div>
        </div>
      )}
    </>
  );
}
