import { useState } from 'react';
import { protocolsApi, type ProtocolRecord } from '../../api';
import XrayOptionFields, { type XrayOpts } from './XrayOptionFields';

interface Props {
  protocol: ProtocolRecord;
  onClose: () => void;
  onSaved: (protocol: ProtocolRecord) => void;
}

// Редактирование параметров inbound'а Xray на живом протоколе.
// Порт здесь не меняется: он зашит в проброс контейнера (docker run -p), его
// смена — это переустановка протокола.
export default function XraySettingsModal({ protocol, onClose, onSaved }: Props) {
  const cfg = (protocol.config ?? {}) as Record<string, any>;
  // Протоколы, поставленные до появления выбора, полей не имеют — показываем
  // те значения, с которыми они реально работают (backend трактует их так же).
  const [opts, setOpts] = useState<XrayOpts>({
    sni: cfg.sni ?? '',
    security: cfg.security ?? 'reality',
    fingerprint: cfg.fingerprint || 'chrome',
    flow: cfg.flow ?? 'xtls-rprx-vision',
    transport: cfg.transport ?? 'tcp',
    xhttpHost: cfg.xhttpHost ?? '',
    xhttpPath: cfg.xhttpPath ?? '',
    xhttpMode: cfg.xhttpMode ?? 'auto',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<number | null>(null);

  const set = (k: string, v: any) => setOpts(o => ({ ...o, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, any> = { ...opts };
      // Пустые строки убираем: backend на пустом значении подставит текущее.
      for (const k of Object.keys(payload)) {
        if (payload[k] === '' && k !== 'flow') delete payload[k];
      }
      const r = await protocolsApi.updateSettings(protocol.id, payload);
      setResult(r.data.reissued);
      onSaved(r.data.protocol);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      <div className="modal" style={{ width: 560 }}>
        <div className="modal-title">Настройки Xray</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="notice notice-info" style={{ fontSize: 11 }}>
            Порт ({protocol.port}) здесь не меняется — он зашит в проброс контейнера.
            После сохранения контейнер перезапустится, а конфиги всех клиентов
            перевыпустятся: uuid сохранятся, но выданные ранее ссылки перестанут
            работать — их нужно раздать заново.
          </div>

          <XrayOptionFields opts={opts} set={set} />

          {error && <div className="notice notice-error" style={{ fontSize: 12 }}>{error}</div>}
          {result !== null && (
            <div className="notice notice-success" style={{ fontSize: 12 }}>
              Сохранено. Перевыпущено конфигов клиентов: {result}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {result !== null ? 'Закрыть' : 'Отмена'}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}
            title="Записать настройки в server.json и перезапустить контейнер — подключённые клиенты на секунду отвалятся">
            {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Сохранить и перезапустить'}
          </button>
        </div>
      </div>
    </div>
  );
}
