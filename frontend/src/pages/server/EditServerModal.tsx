import { useState } from 'react';
import { serversApi, type ServerRecord } from '../../api';

interface Props {
  server: ServerRecord;
  onClose: () => void;
  onSaved: (s: ServerRecord) => void;
}

interface FormState {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'key';
  password: string;
  private_key: string;
}

export default function EditServerModal({ server, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>({
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    auth_type: server.auth_type || 'password',
    password: '',
    private_key: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await serversApi.update(server.id, form);
      onSaved(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to update server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Edit Server</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div className="modal-form">
          <div className="input-group">
            <label className="input-label">Name</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
            <div className="input-group">
              <label className="input-label">Host / IP</label>
              <input className="input input-mono" value={form.host} onChange={e => set('host', e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">Port</label>
              <input className="input input-mono" type="number" value={form.port} onChange={e => set('port', +e.target.value)} />
            </div>
          </div>
          <div className="input-group">
            <label className="input-label">Username</label>
            <input className="input input-mono" value={form.username} onChange={e => set('username', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Auth Type</label>
            <select className="input" value={form.auth_type} onChange={e => set('auth_type', e.target.value as 'password' | 'key')}>
              <option value="password">Password</option>
              <option value="key">SSH Key</option>
            </select>
          </div>
          {form.auth_type === 'password' ? (
            <div className="input-group">
              <label className="input-label">Password <span className="text-muted">(оставьте пустым чтобы не менять)</span></label>
              <input className="input" type="password" placeholder="••••••••" value={form.password} onChange={e => set('password', e.target.value)} />
            </div>
          ) : (
            <div className="input-group">
              <label className="input-label">Private Key (PEM) <span className="text-muted">(оставьте пустым чтобы не менять)</span></label>
              <textarea className="input input-mono" rows={5} placeholder="-----BEGIN RSA PRIVATE KEY-----" value={form.private_key} onChange={e => set('private_key', e.target.value)} />
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? <><span className="spinner" /> Saving…</> : '✓ Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
