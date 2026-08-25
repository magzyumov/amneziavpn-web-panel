import { useState, useEffect } from 'react';
import { protocolsApi } from '../../api';
import { PROTOCOL_ICONS, PROTOCOL_NAMES, type ProtocolType } from '../../protocols';
import XrayOptionFields from './XrayOptionFields';

interface Props {
  serverId: string;
  onClose: () => void;
  onInstalled: (data: any) => void;
}

// Header protection (AWG 3.0) использует S1-S4 как nonce и требует каждый >= 12.
// Бэкенд это тоже проверяет (HP_MIN_JUNK в awg2.ts), но там ошибка доходит до
// пользователя обезличенным "Internal server error" — ловим до отправки.
const S_MIN = 12;
const S_KEYS = ['s1', 's2', 's3', 's4'];

const DEFAULTS: Record<ProtocolType, Record<string, any>> = {
  // jc и S1-S4 оставляем пустыми: их генерирует backend по алгоритму апстрима
  // (AwgInstaller::generateAwgParameters) — случайно и на каждую установку свои.
  // Прежние преднастроенные значения делали параметры одинаковыми у всех серверов,
  // то есть сами по себе становились отпечатком. Jmin/Jmax у апстрима — константы.
  awg2:      { port: '', jc: '', jmin: 10, jmax: 50, s1: '', s2: '', s3: '', s4: '', randomTrailers: true, disableCookies: true },
  xray:      { port: 443, sni: 'www.googletagmanager.com', transport: 'tcp', security: 'reality', fingerprint: 'chrome', flow: 'xtls-rprx-vision' },
  wireguard: { port: '' },
  telemt:    { port: '', tlsDomain: 'www.google.com' },
};

export default function InstallProtocolModal({ serverId, onClose, onInstalled }: Props) {
  const [type, setType] = useState<ProtocolType>('awg2');
  const [opts, setOpts] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');

  const set = (k: string, v: any) => setOpts(o => ({ ...o, [k]: v }));

  const sTooSmall = type === 'awg2'
    ? S_KEYS.filter(k => opts[k] !== '' && opts[k] != null && +opts[k] < S_MIN)
    : [];

  useEffect(() => { setOpts(DEFAULTS[type] || {}); }, [type]);

  const install = async () => {
    setLoading(true);
    setError('');
    setLog(`► Installing ${type}...\n► Pulling Docker image (может занять минуту)...\n`);
    try {
      const options: Record<string, any> = { ...opts };
      if (!options.port) delete options.port;
      // Пустые опциональные строки убираем, чтобы backend применил свои дефолты
      // (assertDomain('') и т.п. бросили бы ошибку на пустой строке).
      for (const k of ['sni', 'xhttpHost', 'xhttpPath', 'xhttpMode', 'tlsDomain']) {
        if (options[k] === '') delete options[k];
      }
      // Поля XHTTP актуальны только для transport=xhttp
      if (type === 'xray' && options.transport !== 'xhttp') {
        delete options.xhttpHost; delete options.xhttpPath; delete options.xhttpMode;
      }
      const r = await protocolsApi.install(serverId, { type, options });
      setLog(l => l + `\n✓ Done!\n  Container: ${r.data.container_name}\n  Port: ${r.data.port}\n`);
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
            {(Object.keys(PROTOCOL_NAMES) as ProtocolType[]).map(t => (
              <option key={t} value={t}>{PROTOCOL_ICONS[t]} {PROTOCOL_NAMES[t]}</option>
            ))}
          </select>
        </div>

        {type === 'awg2' && (
          <div>
            <div className="notice notice-info" style={{ marginBottom: 12, fontSize: 11 }}>
              Пустые поля генерируются на сервере по алгоритму AmneziaVPN 5.0.1.5.
              S1-S4 служат nonce для защиты заголовков, поэтому каждый должен быть
              не меньше {S_MIN} — иначе AmneziaWG отвергнет конфиг. H1-H4 при
              защите заголовков всегда 1/2/3/4, как в апстриме.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { k: 'port',  label: 'UDP Port (пусто = random)' },
                { k: 'jc',   label: 'Jc (junk count, 3-10)' },
                { k: 'jmin', label: 'Jmin' },
                { k: 'jmax', label: 'Jmax' },
                { k: 's1',   label: `S1 (мин. ${S_MIN})` },
                { k: 's2',   label: `S2 (мин. ${S_MIN})` },
                { k: 's3',   label: `S3 (мин. ${S_MIN})` },
                { k: 's4',   label: `S4 (мин. ${S_MIN})` },
              ].map(f => (
                <div key={f.k} className="input-group">
                  <label className="input-label">{f.label}</label>
                  <input className="input input-mono" type="number"
                    min={S_KEYS.includes(f.k) ? S_MIN : undefined}
                    value={opts[f.k] ?? ''} placeholder="auto"
                    onChange={e => set(f.k, e.target.value === '' ? '' : +e.target.value)} />
                </div>
              ))}
            </div>
            {sTooSmall.length > 0 && (
              <div className="notice notice-error" style={{ marginTop: 10, fontSize: 11 }}>
                {sTooSmall.join(', ').toUpperCase()} меньше {S_MIN} — установка не пройдёт.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={opts.randomTrailers !== false}
                  onChange={e => set('randomTrailers', e.target.checked)} />
                RandomTrailers — случайный хвост у handshake-пакетов (AWG 3.1)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input type="checkbox" checked={opts.disableCookies !== false}
                  onChange={e => set('disableCookies', e.target.checked)} />
                DisableCookies — не отвечать cookie-пакетами (AWG 3.1)
              </label>
            </div>
            {opts.randomTrailers !== false && (
              <div className="notice notice-warning" style={{ marginTop: 10, fontSize: 11 }}>
                RandomTrailers требует AmneziaVPN <b>5.0.1.5</b> или новее у всех клиентов:
                приложение постарше ждёт handshake-ответ точного размера и молча его отбросит.
                Выключите галочку, если клиенты ещё не обновились.
              </div>
            )}
          </div>
        )}

        {type === 'xray' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="input-group">
              <label className="input-label">Port</label>
              <input className="input input-mono" type="number" value={opts.port ?? 443}
                onChange={e => set('port', +e.target.value)} />
            </div>
            <XrayOptionFields opts={opts} set={set} />
            <div className="notice notice-info" style={{ fontSize: 11 }}>
              Ключи Reality генерируются автоматически через xray x25519 — в том числе
              при security=none, чтобы переключить обратно можно было без переустановки.
              Всё, кроме порта, потом меняется в настройках протокола.
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

        {type === 'telemt' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="notice notice-info" style={{ fontSize: 11 }}>
              Telegram-прокси с FakeTLS-маскировкой. Проксирует только трафик Telegram.
              Каждый клиент — отдельный секрет с tg:// ссылкой.
            </div>
            <div className="input-group">
              <label className="input-label">TCP Port (пусто = random)</label>
              <input className="input input-mono" type="number" placeholder="auto"
                value={opts.port ?? ''} onChange={e => set('port', e.target.value === '' ? '' : +e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">
                FakeTLS домен (обязателен)
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
          <button className="btn btn-primary" onClick={install} disabled={loading || sTooSmall.length > 0}
            title="Собрать образ и запустить контейнер на сервере. Занимает пару минут">
            {loading ? <><span className="spinner" /> Installing…</> : '▶ Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
