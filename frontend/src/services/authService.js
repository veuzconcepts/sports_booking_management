import api, { STORAGE_KEYS } from './apiClient';

/** Ensure the CSRF cookie exists before any state-changing request. */
export async function ensureCsrf() {
  try {
    await api.get('/auth/csrf/');
  } catch {
    /* non-fatal - login sets the cookie too */
  }
}

export async function loginRequest(email, password, otp) {
  const payload = { email, password };
  if (otp) payload.otp = otp;
  // Server sets HttpOnly access/refresh cookies + the csrftoken cookie;
  // the body carries only the (non-sensitive) user profile.
  const { data } = await api.post('/auth/login/', payload);
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data.user));
  return data.user;
}

export async function logoutRequest() {
  try {
    await api.post('/auth/logout/');  // blacklists refresh token + clears cookies
  } catch {
    /* ignore - clear local state regardless */
  } finally {
    localStorage.removeItem(STORAGE_KEYS.user);
  }
}

export async function fetchMe() {
  const { data } = await api.get('/auth/me/');
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data));
  return data;
}

export function readStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.user);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
