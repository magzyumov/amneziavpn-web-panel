import { useState } from 'react';
import { clientsApi } from '../../api';
import LimitFields from './LimitFields';

interface Props {
  protocolId: string;
  onClose: () => void;
  onAdded: (client: any) => void;
}

export default function AddClientModal({ protocolId, onClose, onAdded }: Props) {
  const [name, setName] = useState('');
  // Строками, а не числами: пустое поле в контролируемом number-input иначе
  // невозможно очистить.
  const [expiresInDays, setExpiresInDays] = useState('0');
  const [dailyLimitMb, setDailyLimitMb] = useState('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name) return;
    setLoading(true);
    setError('');
    try {
      const r = await clientsApi.create({
        protocolId, name,
        expiresInDays: Number(expiresInDays) || 0,
        dailyLimitMb: Number(dailyLimitMb) || 0,
      });
      onAdded(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="modal-title">Add Client</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="input-group">
          <label className="input-label">Client Name</label>
          <input className="input" placeholder="e.g. iPhone, Laptop" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
        </div>

        <LimitFields
          expiresInDays={expiresInDays}
          dailyLimitMb={dailyLimitMb}
          onExpiryChange={setExpiresInDays}
          onLimitChange={setDailyLimitMb}
        />

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading || !name}>
            {loading ? <span className="spinner" /> : '+ Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
