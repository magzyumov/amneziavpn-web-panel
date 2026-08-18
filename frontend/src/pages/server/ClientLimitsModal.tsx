import { useState } from 'react';
import { clientsApi, type ClientRecord } from '../../api';
import LimitFields from './LimitFields';
import { formatBytes } from './format';

interface Props {
  client: ClientRecord;
  onClose: () => void;
  /** null = клиент удалён (срок выставлен в прошлое). */
  onSaved: (updated: ClientRecord | null) => void;
}

// Срок отсчитывается от момента сохранения, а не от создания клиента: «7 дней»
// в этой форме означает «ещё неделю с этого момента» — так и работает продление.
export default function ClientLimitsModal({ client, onClose, onSaved }: Props) {
  const currentDaysLeft = client.expires_at
    ? Math.max(0, Math.ceil((client.expires_at - Date.now() / 1000) / 86400))
    : 0;

  const [expiresInDays, setExpiresInDays] = useState(String(currentDaysLeft));
  const [dailyLimitMb, setDailyLimitMb] = useState(String(Math.round(client.daily_limit_bytes / (1024 * 1024))));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await clientsApi.setLimits(client.id, {
        expiresInDays: Number(expiresInDays) || 0,
        dailyLimitMb: Number(dailyLimitMb) || 0,
      });
      if ('deleted' in r.data) onSaved(null);
      else onSaved({ ...client, ...r.data });
    } catch (e: any) {
      setError(e.response?.data?.error || 'Не удалось сохранить лимиты');
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="modal-title">Лимиты · {client.name}</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}

        {!!client.suspended_at && (
          <div className="notice" style={{ marginBottom: 12 }}>
            Сейчас приостановлен: за сегодня израсходовано {formatBytes(client.used_today)}.
            Поднимите лимит — доступ вернётся сразу, ждать полуночи не нужно.
          </div>
        )}

        <LimitFields
          expiresInDays={expiresInDays}
          dailyLimitMb={dailyLimitMb}
          onExpiryChange={setExpiresInDays}
          onLimitChange={setDailyLimitMb}
        />

        <div className="text-muted mono" style={{ fontSize: 10, marginBottom: 12 }}>
          // срок отсчитывается заново от текущего момента
        </div>

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}
            title="Применить лимиты сразу: если клиент приостановлен, а лимит поднят — он вернётся немедленно">
            {loading ? <span className="spinner" /> : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
