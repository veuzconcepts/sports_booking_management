import { useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Lock, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';

import { Modal } from './Modal.jsx';
import { FormField } from './FormField.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { accountApi } from '../services/usersService.js';

// Pull a human message out of a DRF error (detail or field errors).
function apiErr(e, fallback) {
  const d = e?.response?.data;
  if (!d) return fallback;
  if (typeof d.detail === 'string') return d.detail;
  const parts = Object.entries(d).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`);
  return parts.join(' · ') || fallback;
}

/**
 * Self-service account security card - change password + enable/disable MFA.
 * Used on the profile page AND the admin Users page. The admin page injects its
 * session-management UI via `sessionsSlot` (kept there to avoid coupling).
 *
 * MFA model (M365): an admin can't enrol on your behalf - you enrol here on your
 * own device. While an admin has MFA "Disabled" for you, enrolment is blocked.
 */
export function AccountSecurityCard({ sessionsSlot = null }) {
  const { user } = useAuth();
  const [mfaEnabled, setMfaEnabled] = useState(Boolean(user?.mfa_enabled));
  const [pwOpen, setPwOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  // Locked = required by role OR enforced by an admin (can't self-disable).
  const mfaLocked = Boolean(user?.mfa_required || user?.mfa_enforced);
  // Disabled = an admin turned MFA off for this account (can't self-enrol until
  // re-enabled). A mandated account is never effectively disabled.
  const mfaDisabled = Boolean(user?.mfa_disabled) && !mfaLocked;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title"><Lock size={15} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />Your account security</h3>
          <p className="card-subtitle">{user?.email}</p>
        </div>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <StatusBadge tone={mfaEnabled ? 'success' : 'muted'} label={mfaEnabled ? 'MFA on' : 'MFA off'} />
          {mfaLocked && <StatusBadge tone="warning" label="Enforced" />}
          {mfaDisabled && <StatusBadge tone="danger" label="Disabled" />}
        </span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-secondary" onClick={() => setPwOpen(true)}><KeyRound size={15} /> Change my password</button>
        {!mfaEnabled && !mfaDisabled && (
          <button className="btn btn-primary" onClick={() => setMfaOpen(true)}><ShieldCheck size={15} /> Enable MFA</button>
        )}
        {!mfaEnabled && mfaDisabled && (
          <span className="muted" style={{ fontSize: 13 }}>
            MFA is turned off for your account. Ask an administrator to enable it.
          </span>
        )}
        {mfaEnabled && !mfaLocked && (
          <button className="btn btn-ghost" onClick={() => setDisableOpen(true)}><ShieldOff size={15} /> Disable MFA</button>
        )}
        {mfaEnabled && mfaLocked && (
          <span className="muted" style={{ fontSize: 13 }}>
            MFA is enforced for your account; contact an administrator to change it.
          </span>
        )}
      </div>

      {sessionsSlot}

      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <EnableMfaModal open={mfaOpen} onClose={() => setMfaOpen(false)}
        onEnabled={() => { setMfaEnabled(true); setMfaOpen(false); toast.success('MFA enabled'); }} />
      <DisableMfaModal open={disableOpen} onClose={() => setDisableOpen(false)}
        onDisabled={() => { setMfaEnabled(false); setDisableOpen(false); toast.success('MFA disabled'); }} />
    </div>
  );
}

function ChangePasswordModal({ open, onClose }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm();
  async function onSubmit(v) {
    try {
      await accountApi.changePassword(v.old_password, v.new_password);
      reset(); onClose(); toast.success('Password updated');
    } catch (e) {
      toast.error(apiErr(e, 'Unable to change your password. Please try again.'));
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Change my password" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>Update</button>
      </>}>
      <FormField label="Current password" error={errors.old_password?.message}>
        <input className="form-input" type="password" {...register('old_password', { required: 'Required' })} />
      </FormField>
      <FormField label="New password" error={errors.new_password?.message}
                 hint="Min 10 chars with upper, lower, digit, and a symbol.">
        <input className="form-input" type="password" {...register('new_password', { required: 'Required', minLength: { value: 10, message: 'Min 10 characters' } })} />
      </FormField>
    </Modal>
  );
}

function EnableMfaModal({ open, onClose, onEnabled }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    try { setSetup(await accountApi.mfaSetup()); }
    catch (e) { toast.error(apiErr(e, 'Unable to start multi-factor setup. Please try again.')); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    try { await accountApi.mfaConfirm(code); setSetup(null); setCode(''); onEnabled(); }
    catch (e) { toast.error(apiErr(e, 'The verification code is invalid. Please try again.')); }
    finally { setBusy(false); }
  }

  function close() { setSetup(null); setCode(''); onClose(); }

  return (
    <Modal open={open} onClose={close} title="Enable multi-factor authentication" size="sm"
      footer={setup
        ? <>
            <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={confirm} disabled={busy || code.length < 6}>Confirm</button>
          </>
        : <>
            <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={begin} disabled={busy}>Start setup</button>
          </>}>
      {!setup ? (
        <p className="muted">Generate a secret, scan it with an authenticator app
          (Google Authenticator, Authy, 1Password…), then confirm with a code.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
        </div>
      )}
    </Modal>
  );
}

function DisableMfaModal({ open, onClose, onDisabled }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    setBusy(true);
    setErr('');
    // A 403 here (role-required / enforced) carries the exact backend message;
    // show it inline rather than toast-and-vanish.
    try { await accountApi.mfaDisable({ code }); setCode(''); onDisabled(); }
    catch (e) { setErr(apiErr(e, 'Unable to disable multi-factor authentication. Please try again.')); }
    finally { setBusy(false); }
  }
  function close() { setErr(''); setCode(''); onClose(); }
  return (
    <Modal open={open} onClose={close} title="Disable MFA" size="sm"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || code.length < 6}>Disable</button>
      </>}>
      {err && (
        <div style={{
          marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid rgba(220,38,38,0.25)',
        }}>{err}</div>
      )}
      <FormField label="Authenticator code" hint="Confirm with a current 6-digit code.">
        <input className="form-input" inputMode="numeric" placeholder="123456"
               value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      </FormField>
    </Modal>
  );
}
