import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, User as UserIcon, Menu, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAuth } from '../hooks/useAuth.jsx';
import { NotificationBell } from '../components/NotificationBell.jsx';

function initials(user) {
  if (!user) return '';
  const a = user.first_name?.[0] || '';
  const b = user.last_name?.[0] || '';
  return (a + b).toUpperCase() || user.email?.[0]?.toUpperCase() || '?';
}

export function Topbar({ onMenuClick, navOpen }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const menuRef = useRef(null);

  useEffect(() => {
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function handleLogout() {
    await logout();
    toast.success('Signed out');
    navigate('/login', { replace: true });
  }

  return (
    <header className="topbar">
      <button
        className="topbar-menu-btn"
        onClick={onMenuClick}
        aria-label={navOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={navOpen}
      >
        {navOpen ? <X size={22} /> : <Menu size={22} />}
      </button>

      <div className="topbar-brand">
        <div className="topbar-brand-mark">DC</div>
        <div className="topbar-brand-text">
          <span className="topbar-brand-name">Club Booking</span>
          <span className="topbar-brand-tag">Club & Facility Booking Management</span>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <div className="topbar-actions">
        <NotificationBell />

        <div className="user-menu" ref={menuRef}>
          <button
            className="user-chip"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={open}
          >
            <div className="user-avatar">{initials(user)}</div>
            <div>
              <div className="user-chip-name">{user?.full_name || user?.email}</div>
              <div className="user-chip-role">{user?.role?.replace('_', ' ')}</div>
            </div>
            <ChevronDown size={14} style={{ color: '#9fb0c9' }} />
          </button>

          {open && (
            <div className="user-menu-dropdown">
              <button onClick={() => { setOpen(false); navigate('/profile'); }}>
                <UserIcon size={15} /> My profile
              </button>
              <button onClick={handleLogout}>
                <LogOut size={15} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
