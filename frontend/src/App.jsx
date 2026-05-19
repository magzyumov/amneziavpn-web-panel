import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, Link, useLocation } from 'react-router-dom';
import { authApi } from './api.js';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import ServerPage from './pages/ServerPage.jsx';
import SubscriptionsPage from './pages/SubscriptionsPage.jsx';

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #080c10;
    --surface: #0d1117;
    --surface2: #161b22;
    --surface3: #1c2333;
    --border: #21262d;
    --border-glow: #2d8fff33;
    --text: #e6edf3;
    --text-dim: #7d8590;
    --text-muted: #484f58;
    --accent: #2d8fff;
    --accent-dim: #1a4f99;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #a371f7;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'Space Grotesk', sans-serif;
    --radius: 6px;
    --transition: 150ms ease;
  }

  html, body, #root { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* Layout */
  .app { display: flex; height: 100vh; overflow: hidden; }

  /* Sidebar */
  .sidebar {
    width: 220px;
    min-width: 220px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 0;
  }
  .sidebar-logo {
    padding: 20px 16px 16px;
    border-bottom: 1px solid var(--border);
  }
  .logo-text {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.05em;
  }
  .logo-sub { font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; }
  .sidebar-nav { flex: 1; padding: 12px 0; overflow-y: auto; }
  .nav-section { padding: 0 16px 8px; }
  .nav-section-label { font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.1em; padding: 8px 0 4px; }
  .nav-link {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: var(--radius);
    color: var(--text-dim); font-size: 13px;
    text-decoration: none; transition: var(--transition);
    cursor: pointer;
  }
  .nav-link:hover { background: var(--surface2); color: var(--text); }
  .nav-link.active { background: var(--accent-dim); color: var(--accent); }
  .nav-link .icon { font-size: 14px; width: 16px; text-align: center; }
  .sidebar-bottom {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .logout-btn {
    width: 100%; padding: 6px 8px;
    background: none; border: none;
    color: var(--text-dim); font-size: 13px;
    cursor: pointer; text-align: left;
    border-radius: var(--radius);
    font-family: var(--font-sans);
    transition: var(--transition);
  }
  .logout-btn:hover { background: var(--surface2); color: var(--red); }

  /* Main */
  .main { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .page-header {
    padding: 20px 28px 0;
    border-bottom: 1px solid var(--border);
    padding-bottom: 16px;
  }
  .page-title { font-size: 18px; font-weight: 600; }
  .page-sub { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); margin-top: 2px; }
  .page-body { padding: 24px 28px; flex: 1; }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .card:hover { border-color: var(--border-glow); }
  .card-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-family: var(--font-mono); }

  /* Grid */
  .grid { display: grid; gap: 12px; }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: var(--radius);
    font-size: 13px; font-weight: 500; cursor: pointer;
    border: 1px solid transparent; transition: var(--transition);
    font-family: var(--font-sans);
    white-space: nowrap;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-primary:hover:not(:disabled) { background: #3d9fff; }
  .btn-outline { background: transparent; color: var(--text-dim); border-color: var(--border); }
  .btn-outline:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .btn-danger { background: transparent; color: var(--red); border-color: var(--border); }
  .btn-danger:hover:not(:disabled) { border-color: var(--red); background: #f8514922; }
  .btn-ghost { background: transparent; border-color: transparent; color: var(--text-dim); padding: 4px 8px; }
  .btn-ghost:hover:not(:disabled) { color: var(--text); background: var(--surface2); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* Inputs */
  .input {
    width: 100%; padding: 7px 12px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text);
    font-size: 13px; font-family: var(--font-sans);
    transition: var(--transition); outline: none;
  }
  .input:focus { border-color: var(--accent); }
  .input::placeholder { color: var(--text-muted); }
  .input-group { display: flex; flex-direction: column; gap: 4px; }
  .input-label { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; }
  .input-mono { font-family: var(--font-mono); font-size: 12px; }
  select.input { cursor: pointer; }
  textarea.input { resize: vertical; min-height: 80px; }

  /* Status badges */
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 20px;
    font-size: 11px; font-family: var(--font-mono); font-weight: 500;
  }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .badge-running { color: var(--green); background: #3fb95015; }
  .badge-stopped { color: var(--text-muted); background: #ffffff08; }
  .badge-error { color: var(--red); background: #f8514915; }

  /* Protocol icons */
  .proto-icon { font-size: 24px; margin-bottom: 8px; }

  /* Mono text */
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .text-dim { color: var(--text-dim); }
  .text-muted { color: var(--text-muted); }
  .text-accent { color: var(--accent); }
  .text-green { color: var(--green); }
  .text-red { color: var(--red); }

  /* Spacing */
  .mt-4 { margin-top: 4px; }
  .mt-8 { margin-top: 8px; }
  .mt-12 { margin-top: 12px; }
  .mt-16 { margin-top: 16px; }
  .mt-24 { margin-top: 24px; }
  .flex { display: flex; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }
  .gap-8 { gap: 8px; }
  .gap-12 { gap: 12px; }
  .gap-16 { gap: 16px; }
  .flex-1 { flex: 1; }

  /* Auth pages */
  .auth-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg);
  }
  .auth-box {
    width: 380px; background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius); padding: 32px;
  }
  .auth-title { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .auth-sub { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); margin-bottom: 24px; }
  .auth-form { display: flex; flex-direction: column; gap: 14px; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 100;
    backdrop-filter: blur(4px);
  }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 24px; width: 480px;
    max-height: 80vh; overflow-y: auto;
  }
  .modal-title { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
  .modal-form { display: flex; flex-direction: column; gap: 14px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }

  /* Terminal/logs */
  .terminal {
    background: #010409; border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px;
    font-family: var(--font-mono); font-size: 12px; color: #7ee787;
    max-height: 300px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-all;
  }

  /* Loading */
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes qr-progress { from { width: 0%; } to { width: 100%; } }
  .spinner {
    width: 16px; height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    display: inline-block;
  }

  /* Tables */
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
  .table th { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .table tr:last-child td { border-bottom: none; }
  .table tr:hover td { background: var(--surface2); }

  /* Config display */
  .config-box {
    background: #010409; border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px;
    font-family: var(--font-mono); font-size: 11px; color: #7ee787;
    white-space: pre-wrap; word-break: break-all;
    max-height: 200px; overflow-y: auto;
  }

  /* QR */
  .qr-img { display: block; margin: 0 auto; border-radius: var(--radius); background: white; padding: 8px; }

  /* Empty state */
  .empty-state { text-align: center; padding: 48px 24px; color: var(--text-muted); }
  .empty-icon { font-size: 32px; margin-bottom: 12px; }
  .empty-text { font-size: 13px; }

  /* Mobile top bar */
  .mobile-topbar {
    display: none; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--surface); position: sticky; top: 0; z-index: 100;
    flex-shrink: 0;
  }
  .hamburger {
    background: transparent; border: 1px solid var(--border);
    color: var(--text); border-radius: var(--radius);
    padding: 4px 9px; cursor: pointer; font-size: 16px; line-height: 1;
  }

  /* Sidebar overlay (mobile) */
  .sidebar-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6); z-index: 190;
    backdrop-filter: blur(2px);
  }

  /* Client list columns */
  .col-name { width: 550px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-date { width: 88px; flex-shrink: 0; }
  .col-date-hdr { width: 88px; flex-shrink: 0; font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; }
  .col-actions { width: 186px; flex-shrink: 0; display: flex; gap: 8px; }
  .col-actions-hdr { width: 186px; flex-shrink: 0; }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .mobile-topbar { display: flex; }

    .sidebar {
      position: fixed; left: 0; top: 0; bottom: 0; z-index: 200;
      transform: translateX(-100%);
      transition: transform 0.25s ease;
      box-shadow: 4px 0 24px rgba(0,0,0,0.5);
    }
    .sidebar.sidebar-open { transform: translateX(0); }

    .page-header { padding: 14px 16px; }
    .page-body { padding: 16px; }
    .page-header-row { flex-direction: column !important; align-items: flex-start !important; gap: 10px; }
    .page-header-actions { flex-wrap: wrap; }

    .modal { width: calc(100vw - 24px) !important; padding: 16px; }

    .proto-card-actions { flex-wrap: wrap; }

    .col-name { width: 160px; }
    .col-date { display: none !important; }
    .col-date-hdr { display: none !important; }
    .col-actions { width: auto; flex: 1; min-width: 0; justify-content: flex-end; }
    .col-actions-hdr { display: none; }
  }

  @media (max-width: 480px) {
    .page-header { padding: 10px 12px; }
    .page-body { padding: 12px; }
    .card { padding: 12px; }
    .col-name { width: 110px; }
  }

  /* Toast-like notices */
  .notice {
    padding: 10px 14px; border-radius: var(--radius);
    font-size: 12px; font-family: var(--font-mono);
    border-left: 3px solid;
  }
  .notice-error { background: #f8514910; border-color: var(--red); color: var(--red); }
  .notice-success { background: #3fb95010; border-color: var(--green); color: var(--green); }
  .notice-info { background: #2d8fff10; border-color: var(--accent); color: var(--accent); }
`;

function Sidebar({ isOpen, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    try { await authApi.logout(); } catch {}
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

function PrivateLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'ok' | 'no'

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
    <>
      <style>{STYLES}</style>
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
    </>
  );
}
