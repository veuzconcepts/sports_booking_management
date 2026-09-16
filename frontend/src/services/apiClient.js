/**
 * Central Axios instance - cookie-based JWT auth.
 *
 *  - Tokens live in HttpOnly cookies set by the server; JS never reads or stores
 *    them, so XSS cannot exfiltrate a session. We only send `withCredentials`.
 *  - CSRF: the server sets a readable `csrftoken` cookie; axios echoes it back in
 *    the `X-CSRFToken` header on unsafe requests (configured below).
 *  - On 401 we attempt a single cookie-based refresh and replay the request.
 *
 * Requests use a relative base URL so they are same-origin with the SPA (the
 * Vite dev server proxies `/api` to the backend), which is what lets the
 * HttpOnly cookies flow.
 */

import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

// Only a non-sensitive cached profile is persisted - never tokens.
export const STORAGE_KEYS = { user: 'cw_user' };

const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  xsrfCookieName: 'csrftoken',
  xsrfHeaderName: 'X-CSRFToken',
  headers: { 'Content-Type': 'application/json' },
});

let refreshInFlight = null;

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = api
      .post('/auth/refresh/')
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

const NO_RETRY = ['/auth/login', '/auth/refresh', '/auth/logout'];

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const url = original?.url || '';
    if (
      error.response?.status === 401 &&
      !original._retry &&
      !NO_RETRY.some((p) => url.includes(p))
    ) {
      original._retry = true;
      try {
        await refreshSession();
        return api(original);
      } catch (e) {
        localStorage.removeItem(STORAGE_KEYS.user);
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.assign('/login');
        }
        return Promise.reject(e);
      }
    }
    return Promise.reject(error);
  },
);

export default api;
