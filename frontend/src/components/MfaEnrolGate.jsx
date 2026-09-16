import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ShieldCheck, LogOut } from 'lucide-react';

import { FormField } from './FormField.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { accountApi } from '../services/usersService.js';
import { apiErrorMessage } from '../utils/apiError';

/**
 * Full-screen mandatory MFA enrolment. Shown by ProtectedRoute when the logged-in
 * user is required/enforced but not yet enrolled - mirrors the backend gate
 * (CookieJWTAuthentication -> 403 mfa_enrolment_required). Setup starts
 * automatically (one step: scan the QR + confirm), since there's nothing to
 * decide first. The setup/confirm endpoints are allow-listed server-side.
 */
export function MfaEnrolGate() {
  const { logout, refreshUser } = useAuth();
  const [setup, setSetup] = useState(null);   // { qr, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const started = useRef(false);              // guard against double-start (StrictMode)

  async function begin() {
    setBusy(true);
    setErr('');
    try { setSetup(await accountApi.mfaSetup()); }
    catch (e) { setErr(apiErrorMessage(e, 'Unable to start multi-factor setup. Please try again.')); }
    finally { setBusy(false); }
  }

  // Auto-start enrolment on mount - no "Start setup" step.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, []);

  async function confirm() {
    setBusy(true);
    try {
      await accountApi.mfaConfirm(code);
      toast.success('MFA enabled');
      await refreshUser();   // mfa_enabled now true -> ProtectedRoute clears the gate
    } catch (e) {
      toast.error(apiErrorMessage(e, 'The verification code is invalid. Please try again.'));
    } finally {
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
            <ShieldCheck size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
            Multi-factor authentication required
          </h3>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Your administrator requires MFA. Scan the QR code with an authenticator app
            (Google Authenticator, Authy, 1Password…) and enter the 6-digit code to continue.
          </p>

          {err ? (
            <>
              <div style={{
                padding: '10px 12px', borderRadius: 8, fontSize: 13,
                background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)',
              }}>{err}</div>
              <button className="btn btn-primary" onClick={begin} disabled={busy}>Try again</button>
            </>
          ) : !setup ? (
            <p className="muted">Preparing your setup…</p>
          ) : (
            <>
              <div style={{ textAlign: 'center' }}>
                <img src={setup.qr} alt="MFA QR code" style={{ width: 180, height: 180 }} />
              </div>
              <FormField label="Manual entry key" hint="If you can't scan the QR code.">
                <input className="form-input" readOnly value={setup.secret} onFocus={(e) => e.target.select()} />
              </FormField>
              <FormField label="Enter the 6-digit code">
                <input className="form-input" inputMode="numeric" placeholder="123456"
                       value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              </FormField>
              <button className="btn btn-primary" onClick={confirm} disabled={busy || code.length < 6}>
                {busy ? 'Verifying…' : 'Confirm & continue'}
              </button>
            </>
          )}

          <button className="btn btn-ghost" onClick={signOut} style={{ alignSelf: 'flex-start' }}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
