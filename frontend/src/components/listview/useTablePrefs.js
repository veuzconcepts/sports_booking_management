import { useCallback, useEffect, useMemo, useState } from 'react';

import { STORAGE_KEYS } from '../../services/apiClient';

/**
 * Per-user, per-table layout preferences: column order, widths, hidden columns
 * and page size.
 *
 * Stored in localStorage because the project has no user-preferences API yet;
 * the shape is deliberately small and portable so moving it to the backend
 * later is a change of `read`/`write` here and nothing else. Only layout is
 * kept - never row data, never anything a user typed, never anything sensitive.
 *
 * The key includes the signed-in user's id so two accounts sharing a browser do
 * not inherit each other's layout.
 */
const PREFIX = 'table_prefs';

function currentUserId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.user);
    return raw ? (JSON.parse(raw)?.id ?? 'anon') : 'anon';
  } catch {
    return 'anon';
  }
}

export function prefsKey(tableKey) {
  return `${PREFIX}:${currentUserId()}:${tableKey}`;
}

function read(tableKey) {
  try {
    const raw = localStorage.getItem(prefsKey(tableKey));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};                       // private mode, blocked storage, bad JSON
  }
}

function write(tableKey, value) {
  try {
    if (value && Object.keys(value).length) {
      localStorage.setItem(prefsKey(tableKey), JSON.stringify(value));
    } else {
      localStorage.removeItem(prefsKey(tableKey));
    }
  } catch { /* storage unavailable: the table still works, it just forgets */ }
}

/**
 * `columns` is the page's full definition list. Returns the columns in the
 * user's order, with their widths applied and hidden ones removed, plus the
 * controls the toolbar needs.
 *
 * A column the page later removes disappears from the stored order on its own,
 * and a column the page later ADDS appears at its defined position rather than
 * being silently hidden, so shipping a new column does not require every user
 * to reset their view.
 */
export function useTablePrefs(tableKey, columns, { defaultPageSize = 25 } = {}) {
  const [prefs, setPrefs] = useState(() => (tableKey ? read(tableKey) : {}));

  useEffect(() => {
    if (tableKey) setPrefs(read(tableKey));
  }, [tableKey]);

  const save = useCallback((next) => {
    setPrefs(next);
    if (tableKey) write(tableKey, next);
  }, [tableKey]);

  const all = useMemo(() => columns.filter(Boolean), [columns]);

  const ordered = useMemo(() => {
    const order = prefs.order || [];
    const byKey = new Map(all.map((c) => [c.key, c]));
    const known = order.map((k) => byKey.get(k)).filter(Boolean);
    const knownKeys = new Set(known.map((c) => c.key));
    // Columns added since the order was saved keep their defined position.
    const rest = all.filter((c) => !knownKeys.has(c.key));
    if (!known.length) return all;
    const out = [...known];
    rest.forEach((c) => {
      const at = all.indexOf(c);
      out.splice(Math.min(at, out.length), 0, c);
    });
    return out;
  }, [all, prefs.order]);

  const hidden = useMemo(() => new Set(prefs.hidden || []), [prefs.hidden]);

  const visible = useMemo(
    () => ordered
      .filter((c) => c.alwaysVisible || !hidden.has(c.key))
      .map((c) => (prefs.widths?.[c.key] ? { ...c, width: prefs.widths[c.key] } : c)),
    [ordered, hidden, prefs.widths],
  );

  const pageSize = prefs.pageSize || defaultPageSize;

  return {
    columns: visible,
    allColumns: ordered,
    hidden,
    pageSize,

    setOrder: (keys) => save({ ...prefs, order: keys }),
    setWidth: (key, width) => save({ ...prefs, widths: { ...(prefs.widths || {}), [key]: width } }),
    setPageSize: (size) => save({ ...prefs, pageSize: size }),

    toggleColumn: (key) => {
      const next = new Set(hidden);
      if (next.has(key)) next.delete(key); else next.add(key);
      save({ ...prefs, hidden: [...next] });
    },

    /** Forget every stored layout choice for this table. */
    reset: () => save({}),
    isCustomised: Boolean(
      prefs.order || prefs.hidden?.length || prefs.widths || prefs.pageSize),
  };
}
