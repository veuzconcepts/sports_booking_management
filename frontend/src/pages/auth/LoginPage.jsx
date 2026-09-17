import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';

import { FormField } from '../../components/FormField.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

export default function LoginPage() {
  const { register, handleSubmit, getValues, setValue, formState: { errors } } = useForm();
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState('credentials');   // 'credentials' | 'otp'
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from?.pathname || '/dashboard';

  async function onSubmit(values) {
    setSubmitting(true);
    try {
      const otp = step === 'otp' ? values.otp : undefined;
      const user = await login(values.email, values.password, otp);
      toast.success(`Welcome back, ${user.first_name || user.email}`);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const data = err.response?.data || {};
      if (data.otp) {
        // MFA enrolled: move to (or stay on) the dedicated code screen.
        if (step !== 'otp') setStep('otp');
        else toast.error('Invalid authenticator code. Try again.');
      } else {
        toast.error(data.detail || 'Invalid email or password. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function backToCredentials() {
    setValue('otp', '');
    setStep('credentials');
  }

  const onOtp = step === 'otp';

  return (
    <div className="auth-shell">
      <div className="auth-hero">
        <div className="auth-hero-brand">
          <div className="auth-hero-mark">CB</div>
          Club & Facility Booking Management
        </div>
        <div>
          <h1>Run every booking like clockwork.</h1>
          <p>
            One platform for clubs, courts, pitches, lanes and halls.
            Live availability, member pricing, staff rosters and
            VAT-compliant invoicing - all in one dashboard.
          </p>
        </div>
        <div className="auth-hero-foot">
          Built by Veuz Concepts · India · KSA · Bahrain
        </div>
      </div>

      <div className="auth-form-pane">
        <div className="auth-form-card fade-in">
          {!onOtp ? (
            <>
              <h2>Sign in to your account</h2>
              <p className="muted">Use your work email and password to continue.</p>
            </>
          ) : (
            <>
              <h2><ShieldCheck size={20} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />Two-step verification</h2>
              <p className="muted">
                Enter the 6-digit code from your authenticator app for <strong>{getValues('email')}</strong>.
              </p>
            </>
          )}

          <form onSubmit={handleSubmit(onSubmit)}>
            {/* Email + password stay registered across steps (RHF keeps values),
                but are only shown on the first step. */}
            <div style={{ display: onOtp ? 'none' : 'block' }}>
              <FormField label="Email address" error={errors.email?.message}>
                <input
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  {...register('email', { required: 'Email is required' })}
                />
              </FormField>

              <FormField label="Password" error={errors.password?.message}>
                <input
                  className="form-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  {...register('password', { required: 'Password is required' })}
                />
              </FormField>
            </div>

            {onOtp && (
              <FormField label="Authenticator code" error={errors.otp?.message}
                         hint="6-digit code from your authenticator app.">
                <input
                  className="form-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  autoFocus
                  {...register('otp', onOtp ? { required: 'Code is required' } : {})}
                />
              </FormField>
            )}

            <button
              className="btn btn-primary btn-block"
              type="submit"
              disabled={submitting}
            >
              {submitting && <Loader2 size={16} className="spin" />}
              {submitting ? 'Signing in…' : onOtp ? 'Verify & sign in' : 'Continue'}
            </button>

            {onOtp && (
              <button
                className="btn btn-ghost btn-block"
                type="button"
                onClick={backToCredentials}
                disabled={submitting}
                style={{ marginTop: 8 }}
              >
                <ArrowLeft size={15} /> Use a different account
              </button>
            )}
          </form>

          {!onOtp && (
            <>
              <div className="auth-form-foot">
                Forgot password? Contact your administrator.
              </div>

              <div className="card" style={{ marginTop: 28, background: '#fafbfd' }}>
                <div className="card-body" style={{ fontSize: 12.5 }}>
                  <strong>Demo accounts</strong>
                  <div className="muted" style={{ marginTop: 6 }}>
                    superadmin@example.com / DemoPass!2024<br />
                    admin@example.com / DemoPass!2024<br />
                    customer1@example.com
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
