import type { ClientRecord, ProtocolRecord } from '../../api';
import StatsTab from './StatsTab';

interface Props {
  client: ClientRecord;
  protocolType: ProtocolRecord['type'];
  onClose: () => void;
}

export default function StatsModal({ client, protocolType, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 500 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div className="modal-title" style={{ margin: 0 }}>📊 {client.name}</div>
            <div className="text-muted mono" style={{ fontSize: 11, marginTop: 4 }}>
              {protocolType?.toUpperCase()} · статистика
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <StatsTab clientId={client.id} protocolType={protocolType} />

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-outline" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
