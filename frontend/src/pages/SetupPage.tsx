import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api';
import AuthForm from './AuthForm';

export default function SetupPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    authApi.status().then(r => {
      if (r.data.configured) navigate('/login');
    });
  }, []);

  const submit = async ({ username, password }: Record<string, string>) => {
    try {
      await authApi.setup({ username, password });
      navigate('/login');
    } catch (e: any) {
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
