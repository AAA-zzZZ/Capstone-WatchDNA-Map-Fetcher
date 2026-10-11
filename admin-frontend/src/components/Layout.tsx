import React from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid,
  Upload,
  Radar,
  Gem,
  BarChart3,
  HeartPulse,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import '../styles/Layout.css';

// One object per nav item: `to` is the route, `icon` is the lucide-react
// component to render next to the label. Add a new page by adding a line here.
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid },
  { to: '/uploads', label: 'Uploads', icon: Upload },
  { to: '/scraper', label: 'Scraper', icon: Radar },
  { to: '/premium-stores', label: 'Premium Stores', icon: Gem },
  { to: '/app-analytics', label: 'App Analytics', icon: BarChart3 },
  { to: '/health', label: 'Health', icon: HeartPulse },
];

const Layout: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">W</div>
          <div>
            <div className="brand-name">WATCHDNA</div>
            <div className="brand-sub">ADMIN</div>
          </div>
        </div>

        <div className="nav-section-label">MENU</div>
        <nav className="nav-links">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`nav-link${isActive ? ' nav-link-active' : ''}`}
              >
                <Icon size={18} strokeWidth={2} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-card">
            <div className="user-avatar">
              {user?.username?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="user-meta">
              <div className="user-name">{user?.username}</div>
              <div className="user-role">{user?.role}</div>
            </div>
          </div>
          <button onClick={handleLogout} className="logout-button">
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <div className="content-column">
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;