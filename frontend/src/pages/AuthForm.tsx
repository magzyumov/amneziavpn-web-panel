import { useState, type FormEvent } from 'react';

export interface AuthField {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'password';
}

interface AuthFormProps {
  title: string;
  sub: string;
  fields: AuthField[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  error?: string;
}

export default function AuthForm({ title, sub, fields, submitLabel, onSubmit, error }: AuthFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const handle = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    try { await onSubmit(values); } finally { setLoading(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="auth-title">{title}</div>
        <div className="auth-sub">{sub}</div>
        {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
        <form className="auth-form" onSubmit={handle}>
          {fields.map(f => (
            <div key={f.name} className="input-group">
              <label className="input-label">{f.label}</label>
              <input
                className="input"
                type={f.type || 'text'}
                placeholder={f.placeholder}
                required
                onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
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
