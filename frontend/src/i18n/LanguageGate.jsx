import { LanguageProvider } from './LanguageProvider.jsx';
import { useAuth } from '../hooks/useAuth.jsx';

/**
 * Feeds the signed-in user into `LanguageProvider`.
 *
 * It sits INSIDE `AuthProvider` so it can read the user's saved preference, and
 * outside everything else so the whole application, including the login screen,
 * renders in the resolved language.
 */
export function LanguageGate({ children }) {
  const { user } = useAuth();
  return <LanguageProvider user={user}>{children}</LanguageProvider>;
}
