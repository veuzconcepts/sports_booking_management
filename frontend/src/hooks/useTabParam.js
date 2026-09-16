import { useSearchParams } from 'react-router-dom';

/**
 * Tab state persisted in the URL query string (`?tab=...`), so refreshing the
 * page (or sharing the link) keeps the active tab instead of resetting to the
 * first one. Drop-in replacement for `useState(defaultKey)`.
 *
 *   const [tab, setTab] = useTabParam('users');
 */
export function useTabParam(defaultKey, param = 'tab') {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get(param) || defaultKey;

  const setTab = (key) => {
    const next = new URLSearchParams(searchParams);   // preserve other params
    next.set(param, key);
    setSearchParams(next, { replace: true });         // don't spam browser history
  };

  return [tab, setTab];
}
