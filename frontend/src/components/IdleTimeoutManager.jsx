import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from './ConfirmDialog.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { accountApi } from '../services/usersService.js';

// Idle policy. Env overrides exist mainly to speed up manual testing; defaults
// are the enterprise standard: 30 min idle, then a 60s warning, then logout.
const IDLE_MS = (Number(import.meta.env.VITE_IDLE_MINUTES) || 30) * 60 * 1000;
const WARN_MS = (Number(import.meta.env.VITE_IDLE_WARN_SECONDS) || 60) * 1000;
const TICK_MS = 1000;
const WRITE_THROTTLE_MS = 1500;          // cap localStorage writes on activity

// Cross-tab coordination via localStorage (shared across same-origin tabs).
const ACTIVITY_KEY = 'cw_idle_activity'; // last user activity, shared by all tabs
const LOGOUT_KEY = 'cw_idle_logout';     // a tab signals others it logged out

function readLastActivity(fallback) {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_KEY));
    return v > 0 ? v : fallback;
  } catch { return fallback; }
}

/**
 * Secure idle-session timeout, synced across tabs. Mounted inside the
 * authenticated layout only (never on /login). Activity (mouse/keyboard/touch/
 * scroll/route) in ANY tab resets the shared idle clock; after IDLE_MS of true
 * inactivity a warning shows for WARN_MS, then logout (revoke refresh + clear
 * session + redirect). A logout in one tab signals the others to redirect too.
 * One timestamp-based interval; listeners cleaned up; tokens stay HttpOnly.
 */
export function IdleTimeoutManager() {
  const { t } = useTranslation('auth');
  const { isAuthenticated, logout } = useAuth();
  const location = useLocation();

  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(Math.round(WARN_MS / 1000));

  const lastActivity = useRef(Date.now());   // local fallback if localStorage is unavailable
  const lastWrite = useRef(0);
  const warnStart = useRef(0);
  const warningRef = useRef(false);
  const loggingOut = useRef(false);
  warningRef.current = warning;

  // Record activity locally + (throttled) to the shared store so other tabs see it.
  function recordActivity(force = false) {
    const t = Date.now();
    lastActivity.current = t;
    if (force || t - lastWrite.current > WRITE_THROTTLE_MS) {
      lastWrite.current = t;
      try { localStorage.setItem(ACTIVITY_KEY, String(t)); } catch { /* ignore */ }
    }
  }

  async function doLogout(kind) {
    if (loggingOut.current) return;
    loggingOut.current = true;
    setWarning(false);
    // Tell other tabs to sign out too.
    try { localStorage.setItem(LOGOUT_KEY, String(Date.now())); } catch { /* ignore */ }
    // Best-effort audit (session still valid), then the real logout: revokes the
    // refresh token + clears cookies/stored user -> ProtectedRoute redirects.
    accountApi.logIdleEvent(kind === 'auto' ? 'idle_logout_auto' : 'idle_logout_manual');
    if (kind === 'auto') toast.error(t('youHaveBeenLoggedOut'));
    try { await logout(); } catch { /* logout clears local state regardless */ }
  }

  function stayLoggedIn() {
    accountApi.logIdleEvent('idle_stay_logged_in');
    recordActivity(true);     // resets the shared clock for every tab
    setWarning(false);
  }

  // Activity listeners - attached once while authenticated. Activity is ignored
  // once the warning is up (the user must explicitly choose).
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const onActivity = () => { if (!warningRef.current) recordActivity(); };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];
    const opts = { passive: true };
    events.forEach((e) => window.addEventListener(e, onActivity, opts));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity, opts));
  }, [isAuthenticated]);

  // Cross-tab signals: another tab's logout -> redirect; another tab's activity
  // while we're warning -> dismiss our warning (the user is active elsewhere).
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const onStorage = (e) => {
      if (e.key === LOGOUT_KEY && e.newValue) {
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.assign('/login');
        }
      } else if (e.key === ACTIVITY_KEY && warningRef.current) {
        if (Number(e.newValue) > warnStart.current) setWarning(false);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isAuthenticated]);

  // Route navigation counts as activity.
  useEffect(() => {
    if (!warningRef.current) recordActivity();
  }, [location.pathname]);

  // Single ticking interval drives both the idle check and the warning countdown.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    recordActivity(true);     // login / refresh = activity; start the shared clock
    loggingOut.current = false;
    const id = setInterval(() => {
      if (loggingOut.current) return;
      const last = readLastActivity(lastActivity.current);
      if (!warningRef.current) {
        if (Date.now() - last >= IDLE_MS) {
          warnStart.current = Date.now();
          setRemaining(Math.round(WARN_MS / 1000));
          setWarning(true);
          accountApi.logIdleEvent('idle_warning_shown');
        }
      } else if (last > warnStart.current) {
        // Activity in this or another tab after the warning began -> dismiss.
        setWarning(false);
      } else {
        const left = WARN_MS - (Date.now() - warnStart.current);
        if (left <= 0) doLogout('auto');
        else setRemaining(Math.ceil(left / 1000));
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAuthenticated || !warning) return null;

  return (
    <ConfirmDialog
      open={warning}
      tone="primary"
      title={t('yourSessionAboutExpire')}
      message={
        <>
          {t('yourSessionAboutExpireDue')}
          <div className="muted" style={{ marginTop: 8 }}>
            {t('youLlLoggedOutAutomatically')} <strong>{remaining}s</strong>.
          </div>
        </>
      }
      confirmLabel={t('stayLogged')}
      cancelLabel={t('logout')}
      onConfirm={stayLoggedIn}
      onClose={() => doLogout('manual')}
    />
  );
}
