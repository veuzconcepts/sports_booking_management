import { useCallback, useEffect, useState } from 'react';

/**
 * Loads a paginated list from a service function and exposes
 * `{ rows, loading, error, query, setQuery, reload }`.
 *
 * `fetcher(params)` should return a DRF-style payload - either
 * `{ results: [...], count }` or a plain array.
 */
export function useApiList(fetcher, initialQuery = {}) {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher(query)
      .then((data) => {
        if (Array.isArray(data)) {
          setRows(data);
          setCount(data.length);
        } else {
          setRows(data.results || []);
          setCount(data.count || 0);
        }
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, [fetcher, query]);

  useEffect(() => { reload(); }, [reload]);

  return { rows, count, loading, error, query, setQuery, reload };
}
