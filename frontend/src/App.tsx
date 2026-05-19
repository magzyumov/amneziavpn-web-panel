import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { authApi } from './api';
import SetupPage from './pages/SetupPage';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ServerPage from './pages/ServerPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import './App.css';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function Sidebar({ isOpen, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    try { await authApi.logout(); } catch { /* ignore */ }
    navigate('/login');
    onClose?.();
  };

  return (
    <aside className={`sidebar${isOpen ? ' sidebar-open' : ''}`}>
      <div className="sidebar-logo">
        <div className="logo-text">◈ AMNEZIA</div>
        <div className="logo-sub">// management panel</div>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-label">navigation</div>
          <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`} onClick={onClose}>
            <span className="icon">⬡</span> Dashboard
          </Link>
          <Link to="/servers" className={`nav-link ${location.pathname.startsWith('/server') ? 'active' : ''}`} onClick={onClose}>
            <span className="icon">⊡</span> Servers
          </Link>
          <Link to="/subscriptions" className={`nav-link ${location.pathname === '/subscriptions' ? 'active' : ''}`} onClick={onClose}>
            <span className="icon">📡</span> Подписки
          </Link>
        </div>
      </nav>
      <div className="sidebar-bottom">
        <button className="logout-btn" onClick={logout}>⎋ Sign out</button>
      </div>
    </aside>
  );
}

type AuthState = 'checking' | 'ok' | 'no';

function PrivateLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    authApi.me().then(() => setAuthState('ok')).catch(() => setAuthState('no'));
  }, []);

  if (authState === 'no') return <Navigate to="/login" />;
  if (authState === 'checking') return null;
  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main">
        <div className="mobile-topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>◈ AMNEZIA</span>
        </div>
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PrivateLayout><DashboardPage /></PrivateLayout>} />
        <Route path="/servers" element={<PrivateLayout><DashboardPage /></PrivateLayout>} />
        <Route path="/server/:id" element={<PrivateLayout><ServerPage /></PrivateLayout>} />
        <Route path="/subscriptions" element={<PrivateLayout><SubscriptionsPage /></PrivateLayout>} />
      </Routes>
    </BrowserRouter>
  );
}
