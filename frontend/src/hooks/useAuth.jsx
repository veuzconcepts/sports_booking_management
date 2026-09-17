import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  ensureCsrf,
  fetchMe,
  loginRequest,
  logoutRequest,
  readStoredUser,
} from '../services/authService';

const AuthContext = createContext(null);

// Customer accounts are mobile-app only - they must never enter the admin panel.
const CUSTOMER_BLOCKED = {
  response: { data: { detail: 'This is a customer account. Please use the customer website to sign in.' } },
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => readStoredUser());
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      // Make sure the CSRF cookie exists, then validate the session via the
      // HttpOnly cookies (apiClient transparently refreshes a stale access token).
      await ensureCsrf();
      try {
        const me = await fetchMe();
        if (me?.role === 'customer') {
          // A customer session must not unlock the admin panel - drop it.
          await logoutRequest().catch(() => {});
          if (active) setUser(null);
        } else if (active) {
          setUser(me);
        }
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setBootstrapping(false);
      }
    })();
    return () => { active = false; };
  }, []); // run once on mount

  const value = useMemo(() => ({
    user,
    bootstrapping,
    isAuthenticated: Boolean(user),
    role: user?.role,
    permissions: user?.effective_permissions || [],
    hasPerm: (code) => (user?.effective_permissions || []).includes(code),
    async login(email, password, otp) {
      const u = await loginRequest(email, password, otp);
      if (u?.role === 'customer') {
        // Clear the cookies the login just set, then surface a clear message.
        await logoutRequest().catch(() => {});
        throw CUSTOMER_BLOCKED;
      }
      setUser(u);
      return u;
    },
    async logout() {
      await logoutRequest();
      setUser(null);
    },
    // Re-fetch /me into context (e.g. after a forced MFA enrolment clears a gate).
    async refreshUser() {
      const me = await fetchMe();
      setUser(me);
      return me;
    },
  }), [user, bootstrapping]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
