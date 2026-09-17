import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';

import { LanguageSelector } from '../../components/LanguageSelector.jsx';
import { FormField } from '../../components/FormField.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useTheme } from '../../theme/ThemeProvider.jsx';

export default function LoginPage() {
  const { t } = useTranslation('auth');
  const { branding } = useTheme();
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
        else toast.error(t('invalidAuthenticatorCodeTryAgain'));
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
          {branding.logoLight || branding.logoDark ? (
            <img
              className="auth-hero-logo"
              src={branding.logoLight || branding.logoDark}
              alt={branding.name || t('clubFacilityBookingManagement')}
            />
          ) : (
            <div className="auth-hero-mark">CB</div>
          )}
          {branding.name || t('clubFacilityBookingManagement')}
        </div>
        <div>
          <h1>{t('hero.headline')}</h1>
          <p>{t('hero.body')}</p>
        </div>
        <div className="auth-hero-foot">
          Built by Veuz Concepts · India · KSA · Bahrain
        </div>
      </div>

      <div className="auth-form-pane">
        {/* Available before sign in: a visitor must be able to read the form
            they are about to fill in. */}
        <div className="auth-lang">
          <LanguageSelector variant="outline" />
        </div>
        <div className="auth-form-card fade-in">
          {!onOtp ? (
            <>
              <h2>{t('signInTitle')}</h2>
              <p className="muted">{t('signInSubtitle')}</p>
            </>
          ) : (
            <>
              <h2><ShieldCheck size={20} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />{t('twoStepTitle')}</h2>
              <p className="muted">
                <Trans i18nKey="twoStepBody" ns="auth"
                  values={{ email: getValues('email') }}
                  components={{ 1: <strong /> }} />
              </p>
            </>
          )}

          <form onSubmit={handleSubmit(onSubmit)}>
            {/* Email + password stay registered across steps (RHF keeps values),
                but are only shown on the first step. */}
            <div style={{ display: onOtp ? 'none' : 'block' }}>
              <FormField label={t('emailAddress')} error={errors.email?.message}>
                <input
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  placeholder={t('emailPlaceholder')}
                  {...register('email', { required: t('emailRequired') })}
                />
              </FormField>

              <FormField label={t('password')} error={errors.password?.message}>
                <input
                  className="form-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  {...register('password', { required: t('passwordRequired') })}
                />
              </FormField>
            </div>

            {onOtp && (
              <FormField label={t('authenticatorCode')} error={errors.otp?.message}
                         hint={t('authenticatorHint')}>
                <input
                  className="form-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  autoFocus
                  {...register('otp', onOtp ? { required: t('codeRequired') } : {})}
                />
              </FormField>
            )}

            <button
              className="btn btn-primary btn-block"
              type="submit"
              disabled={submitting}
            >
              {submitting && <Loader2 size={16} className="spin" />}
              {submitting ? t('signingIn') : onOtp ? t('verifyAndSignIn') : t('continue')}
            </button>

            {onOtp && (
              <button
                className="btn btn-ghost btn-block"
                type="button"
                onClick={backToCredentials}
                disabled={submitting}
                style={{ marginTop: 8 }}
              >
                <ArrowLeft size={15} /> {t('useDifferentAccount')}
              </button>
            )}
          </form>

          {!onOtp && (
            <>
              <div className="auth-form-foot">
                {t('forgotContactAdmin')}
              </div>

              <div className="card" style={{ marginTop: 28, background: '#fafbfd' }}>
                <div className="card-body" style={{ fontSize: 12.5 }}>
                  <strong>{t('demoAccounts')}</strong>
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
