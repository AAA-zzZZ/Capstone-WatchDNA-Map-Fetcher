import React from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import '../styles/Layout.css';

const Layout: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="layout">
      <nav className="navbar">
        <div className="nav-brand">
          <Link to="/">WatchDNA Admin</Link>
        </div>

        <div className="nav-links">
          <Link to="/">Dashboard</Link>
          <Link to="/uploads">Uploads</Link>
          <Link to="/scraper">Scraper</Link>
          <Link to="/premium-stores">Premium Stores</Link>
          <Link to="/app-analytics">App Analytics</Link>
          <Link to="/health">Health</Link>
        </div>

        <div className="nav-user">
          <span className="user-info">
            {user?.username} ({user?.role})
          </span>
          <button onClick={handleLogout} className="logout-button">
            Logout
          </button>
        </div>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>

      <footer className="footer">
        <p>&copy; 2026 WatchDNA Store Locator. All rights reserved.</p>
      </footer>
    </div>
  );
};

export default Layout;
