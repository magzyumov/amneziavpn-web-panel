import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api.js';

function AuthForm({ title, sub, fields, submitLabel, onSubmit, error }) {
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(false);

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    try { await onSubmit(values); } finally { setLoading(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="auth-title">{title}</div>
        <div className="auth-sub">{sub}</div>
        {error && <div className="notice notice-error" style={{marginBottom: 16}}>{error}</div>}
        <form className="auth-form" onSubmit={handle}>
          {fields.map(f => (
            <div key={f.name} className="input-group">
              <label className="input-label">{f.label}</label>
              <input
                className="input"
                type={f.type || 'text'}
                placeholder={f.placeholder}
                required
                onChange={e => setValues(v => ({...v, [f.name]: e.target.value}))}
              />
            </div>
          ))}
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? <span className="spinner" /> : submitLabel}
          </button>
        </form>
      </div>
    </div>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    authApi.status().then(r => {
      if (r.data.configured) navigate('/login');
    });
  }, []);

  const submit = async ({ username, password }) => {
    try {
      await authApi.setup({ username, password });
      navigate('/login');
    } catch (e) {
      setError(e.response?.data?.error || 'Setup failed');
    }
  };

  return <AuthForm
    title="Initial Setup"
    sub="// create admin account"
    fields={[
      { name: 'username', label: 'Username', placeholder: 'admin' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••••••' },
    ]}
    submitLabel="Create Account"
    onSubmit={submit}
    error={error}
  />;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    authApi.status().then(r => {
      if (!r.data.configured) navigate('/setup');
    });
    if (localStorage.getItem('token')) navigate('/');
  }, []);

  const submit = async ({ username, password }) => {
    try {
      const r = await authApi.login({ username, password });
      localStorage.setItem('token', r.data.token);
      navigate('/');
    } catch {
      setError('Invalid credentials');
    }
  };

  return <AuthForm
    title="Amnezia Panel"
    sub="// sign in to continue"
    fields={[
      { name: 'username', label: 'Username', placeholder: 'admin' },
      { name: 'password', label: 'Password', type: 'password', placeholder: '••••••••' },
    ]}
    submitLabel="Sign In"
    onSubmit={submit}
    error={error}
  />;
}
