import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { authApi, type CurrentUser } from './api';
import { AuthContext, useCurrentUser } from './auth';
import SetupPage from './pages/SetupPage';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ServersPage from './pages/ServersPage';
import ServerPage from './pages/ServerPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import MyClientsPage from './pages/MyClientsPage';
import UsersPage from './pages/UsersPage';
import './App.css';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  user: CurrentUser;
}

function Sidebar({ isOpen, onClose, user }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = user.role === 'admin';

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
          {isAdmin ? (
            <>
              <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`} onClick={onClose}>
                <span className="icon">⬡</span> Сводка
              </Link>
              <Link to="/servers" className={`nav-link ${location.pathname.startsWith('/server') ? 'active' : ''}`} onClick={onClose}>
                <span className="icon">⊡</span> Серверы
              </Link>
              <Link to="/subscriptions" className={`nav-link ${location.pathname === '/subscriptions' ? 'active' : ''}`} onClick={onClose}>
                <span className="icon">📡</span> Подписки
              </Link>
              <Link to="/users" className={`nav-link ${location.pathname === '/users' ? 'active' : ''}`} onClick={onClose}>
                <span className="icon">👤</span> Пользователи
              </Link>
            </>
          ) : (
            <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`} onClick={onClose}>
              <span className="icon">⬡</span> Мои клиенты
            </Link>
          )}
        </div>
      </nav>
      <div className="sidebar-bottom">
        <div className="mono text-muted" style={{ fontSize: 11, marginBottom: 8, padding: '0 4px' }}>
          {user.username} · {isAdmin ? 'admin' : 'user'}
        </div>
        <button className="logout-btn" onClick={logout}>⎋ Sign out</button>
      </div>
    </aside>
  );
}

type AuthState = 'checking' | 'ok' | 'no';

interface PrivateLayoutProps {
  children: ReactNode;
  /** Страница только для админов: обычного юзера уводим на его домашнюю. */
  adminOnly?: boolean;
}

function PrivateLayout({ children, adminOnly }: PrivateLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    authApi.me()
      .then(r => { setUser(r.data); setAuthState('ok'); })
      .catch(() => setAuthState('no'));
  }, []);

  if (authState === 'no') return <Navigate to="/login" />;
  if (authState === 'checking' || !user) return null;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <AuthContext.Provider value={user}>
      <div className="app">
        {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} user={user} />
        <main className="main">
          <div className="mobile-topbar">
            <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>◈ AMNEZIA</span>
          </div>
          {children}
        </main>
      </div>
    </AuthContext.Provider>
  );
}

// Домашняя страница зависит от роли: админу — серверы, пользователю — его клиенты.
// Рендерится внутри PrivateLayout, поэтому пользователь здесь уже загружен.
function HomePage() {
  const user = useCurrentUser();
  return user.role === 'admin' ? <DashboardPage /> : <MyClientsPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PrivateLayout><HomePage /></PrivateLayout>} />
        <Route path="/servers" element={<PrivateLayout adminOnly><ServersPage /></PrivateLayout>} />
        <Route path="/server/:id" element={<PrivateLayout adminOnly><ServerPage /></PrivateLayout>} />
        <Route path="/subscriptions" element={<PrivateLayout adminOnly><SubscriptionsPage /></PrivateLayout>} />
        <Route path="/users" element={<PrivateLayout adminOnly><UsersPage /></PrivateLayout>} />
      </Routes>
    </BrowserRouter>
  );
}
