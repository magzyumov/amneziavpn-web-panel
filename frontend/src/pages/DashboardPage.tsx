import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { serversApi } from '../api';

function AddServerModal({ onClose, onAdded }) {
  const [form, setForm] = useState({ name: '', host: '', port: 22, username: 'root', auth_type: 'password', password: '', private_key: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  // Автоопределение IP текущего сервера (откуда открыта панель)
  useEffect(() => {
    const detectedHost = window.location.hostname;
    if (detectedHost && detectedHost !== 'localhost' && detectedHost !== '127.0.0.1') {
      setForm(f => ({ ...f, host: detectedHost }));
    }
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await serversApi.create(form as any);
      onAdded(r.data);
      // Переходим на страницу сервера — там покажем результаты сканирования
      navigate(`/server/${r.data.id}?scan=1`);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to add server');
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Add Server</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <div className="modal-form">
          <div className="input-group">
            <label className="input-label">Name</label>
            <input className="input" placeholder="My VPS" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
            <div className="input-group">
              <label className="input-label">Host / IP</label>
              <input className="input input-mono" placeholder="1.2.3.4" value={form.host} onChange={e => set('host', e.target.value)} />
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
            <select className="input" value={form.auth_type} onChange={e => set('auth_type', e.target.value)}>
              <option value="password">Password</option>
              <option value="key">SSH Key</option>
            </select>
          </div>
          {form.auth_type === 'password' ? (
            <div className="input-group">
              <label className="input-label">Password</label>
              <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)} />
            </div>
          ) : (
            <div className="input-group">
              <label className="input-label">Private Key (PEM)</label>
              <textarea className="input input-mono" rows={5} placeholder="-----BEGIN RSA PRIVATE KEY-----" value={form.private_key} onChange={e => set('private_key', e.target.value)} />
            </div>
          )}
          <div className="notice notice-info" style={{ fontSize: 11 }}>
            After adding, the server will be automatically scanned for existing Amnezia protocols.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? <><span className="spinner" /> Adding…</> : 'Add & Scan Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerCard({ server, onDelete }) {
  const navigate = useNavigate();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const test = async (e) => {
    e.stopPropagation();
    setTesting(true);
    try {
      const r = await serversApi.test(server.id);
      setTestResult(r.data);
    } catch {
      setTestResult({ ok: false, error: 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/server/${server.id}`)}>
      <div className="flex items-center justify-between page-header-row" style={{ gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name}</div>
          <div className="mono text-dim mt-4" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.username}@{server.host}:{server.port}</div>
        </div>
        <div className="flex gap-8" style={{ flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <button className="btn btn-ghost btn-sm" onClick={test} disabled={testing}>
            {testing ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⚡ Test'}
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(server.id)}>✕</button>
        </div>
      </div>
      {testResult && (
        <div className={`notice mt-8 ${testResult.ok ? 'notice-success' : 'notice-error'}`} style={{ marginTop: 12 }}>
          {testResult.ok ? `✓ Connected${testResult.dockerAvailable ? ' · Docker OK' : ' · Docker not found'}` : `✗ ${testResult.error}`}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [servers, setServers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    serversApi.list().then(r => setServers(r.data)).finally(() => setLoading(false));
  }, []);

  const del = async (id) => {
    if (!confirm('Remove server?')) return;
    await serversApi.delete(id);
    setServers(s => s.filter(x => x.id !== id));
  };

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between page-header-row">
          <div>
            <div className="page-title">Servers</div>
            <div className="page-sub">// manage vpn infrastructure</div>
          </div>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Server</button>
        </div>
      </div>
      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>
        ) : servers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⬡</div>
            <div className="empty-text">No servers yet. Add your VPS to get started.</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowAdd(true)}>+ Add Server</button>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {servers.map(s => <ServerCard key={s.id} server={s} onDelete={del} />)}
          </div>
        )}
      </div>
      {showAdd && (
        <AddServerModal
          onClose={() => setShowAdd(false)}
          onAdded={s => { setServers(p => [...p, s]); setShowAdd(false); }}
        />
      )}
    </>
  );
}
