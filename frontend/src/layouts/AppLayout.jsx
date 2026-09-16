import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar } from './Sidebar.jsx';
import { Topbar } from './Topbar.jsx';
import { IdleTimeoutManager } from '../components/IdleTimeoutManager.jsx';
import './layout.css';

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('cw_nav_collapsed') === '1');
  const { pathname } = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = navOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [navOpen]);

  // Remember the desktop panel-collapsed preference.
  useEffect(() => {
    localStorage.setItem('cw_nav_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  return (
    <div className={`app-layout ${collapsed ? 'nav-collapsed' : ''}`}>
      <Topbar onMenuClick={() => setNavOpen((v) => !v)} navOpen={navOpen} />
      <Sidebar
        open={navOpen}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onNavigate={() => setNavOpen(false)}
      />
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <main className="app-content fade-in">
        <Outlet />
      </main>
      <IdleTimeoutManager />
    </div>
  );
}
