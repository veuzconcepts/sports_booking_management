import { useState } from 'react';
import toast from 'react-hot-toast';
import { KeyRound, LogOut } from 'lucide-react';

import { FormField } from './FormField.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { accountApi } from '../services/usersService.js';
import { apiErrorMessage } from '../utils/apiError';

/**
 * Full-screen forced password change. Shown by ProtectedRoute when the logged-in
 * user has must_change_password set (admin "Force Password Change" / reset) -
 * mirrors the backend password_change_required gate. The change-password endpoint
 * is allow-listed, and on success it revokes the session, so we redirect to login.
 */
export function PasswordChangeGate() {
  const { logout } = useAuth();
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
  const canSubmit = Boolean(oldPw) && newPw.length >= 10 && newPw === confirmPw && !busy;

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await accountApi.changePassword(oldPw, newPw);
      // The backend revokes the session on change - sign out and re-login.
      toast.success('Password updated - please sign in again');
      try { await logout(); } finally { window.location.assign('/login'); }
    } catch (e) {
      setErr(apiErrorMessage(e, 'Unable to change your password. Please try again.'));
      setBusy(false);
    }
  }

  async function signOut() {
    try { await logout(); } finally { window.location.assign('/login'); }
  }

  return (
    <div className="center" style={{ minHeight: '100vh', padding: 20 }}>
      <div className="card" style={{ maxWidth: 460, width: '100%' }}>
        <div className="card-header">
          <h3 className="card-title">
            <KeyRound size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
            Set a new password
          </h3>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            You must change your password before continuing.
          </p>
          {err && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, fontSize: 13,
              background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)',
            }}>{err}</div>
          )}
          <FormField label="Current password">
            <input className="form-input" type="password" value={oldPw}
                   onChange={(e) => setOldPw(e.target.value)} autoFocus />
          </FormField>
          <FormField label="New password" hint="Min 10 chars with upper, lower, digit, and a symbol.">
            <input className="form-input" type="password" value={newPw}
                   onChange={(e) => setNewPw(e.target.value)} />
          </FormField>
          <FormField label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}>
            <input className="form-input" type="password" value={confirmPw}
                   onChange={(e) => setConfirmPw(e.target.value)} />
          </FormField>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Updating…' : 'Update password'}
          </button>
          <button className="btn btn-ghost" onClick={signOut} style={{ alignSelf: 'flex-start' }}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
