import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api';
import AuthForm from './AuthForm';

export default function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    authApi.status().then(r => {
      if (!r.data.configured) navigate('/setup');
    });
    authApi.me().then(() => navigate('/')).catch(() => { /* not authed */ });
  }, []);

  const submit = async ({ username, password }: Record<string, string>) => {
    try {
      await authApi.login({ username, password });
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
