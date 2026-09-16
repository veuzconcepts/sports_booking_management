import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth.jsx';
import { MfaEnrolGate } from '../components/MfaEnrolGate.jsx';
import { PasswordChangeGate } from '../components/PasswordChangeGate.jsx';

export function ProtectedRoute({ children, roles, perm }) {
  const { isAuthenticated, role, bootstrapping, user, hasPerm } = useAuth();
  const location = useLocation();

  if (bootstrapping) {
    return (
      <div className="center" style={{ height: '100vh' }}>
        <div className="muted">Loading…</div>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  // Forced password change first (matches the backend gate order) -> the user
  // must set a new password before anything else.
  if (user?.must_change_password) {
    return <PasswordChangeGate />;
  }
  // MFA mandated (by role or admin enforcement) but not yet enrolled -> force
  // enrolment before anything else (mirrors the backend mfa_enrolment_required
  // gate). The enrol screen uses the allow-listed setup/confirm endpoints.
  if ((user?.mfa_required || user?.mfa_enforced) && !user?.mfa_enabled) {
    return <MfaEnrolGate />;
  }
  if (roles && roles.length > 0 && !roles.includes(role)) {
    return <Navigate to="/dashboard" replace />;
  }
  // Capability gate: a required permission code (mirrors the backend gate).
  if (perm && !hasPerm(perm)) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}
