import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The state behind a listing page: search text, filters, sort, grouping and
 * paging, kept in the URL so a refresh, the browser Back button and a pasted
 * link all restore the same view.
 *
 * Only the page's OWN keys are read and written, so a listing that shares a
 * route with other query parameters (a `?tab=` for instance) leaves them alone.
 *
 * Search is debounced before it reaches the URL or the API: typing eight
 * characters should be one request, not eight.
 */
export const SEARCH_DEBOUNCE_MS = 350;

const RESERVED = ['search', 'ordering', 'page', 'page_size', 'group_by'];

/**
 * Query params -> the API call. Blank values are dropped, not sent as "".
 *
 * A filter may declare `toParams(value)` when one choice maps to several
 * backend parameters (a "Locked" status meaning `locked=true&is_deleted=false`,
 * for instance). The URL keeps the single readable key; only the request is
 * expanded, so a shared link stays legible.
 *
 * `always` is merged underneath everything: a listing's baseline scope, such as
 * hiding soft-deleted rows until a filter asks for them.
 */
export function toApiParams(state, { pageSize, filters = [], always = {} }) {
  const params = { page: state.page || 1, page_size: pageSize, ...always };
  if (state.search) params.search = state.search;
  if (state.ordering) params.ordering = state.ordering;

  const byKey = new Map(filters.map((f) => [f.key, f]));
  Object.entries(state.filters || {}).forEach(([key, value]) => {
    if (value === '' || value === null || value === undefined) return;
    const expand = byKey.get(key)?.toParams;
    if (expand) Object.assign(params, expand(value));
    else params[key] = value;
  });
  return params;
}

export function useListQuery({
  tableKey,
  filters = [],
  defaultOrdering = null,
  defaultFilters = {},
  syncUrl = true,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKeys = useMemo(() => filters.map((f) => f.key), [filters]);

  // --- reading the URL ------------------------------------------------------
  const fromUrl = useMemo(() => {
    const active = {};
    filterKeys.forEach((key) => {
      const value = searchParams.get(key);
      if (value !== null && value !== '') active[key] = value;
    });
    return {
      search: searchParams.get('search') || '',
      ordering: searchParams.get('ordering') || defaultOrdering,
      page: Number(searchParams.get('page')) || 1,
      groupBy: searchParams.get('group_by') || '',
      filters: Object.keys(active).length ? active : { ...defaultFilters },
    };
    // `searchParams` is a new object each render; its string form is the value.
  }, [searchParams.toString(), filterKeys.join(','), defaultOrdering]);   // eslint-disable-line

  const state = syncUrl ? fromUrl : undefined;
  const [local, setLocal] = useState(() => fromUrl);
  const current = syncUrl ? state : local;

  // The search box is uncontrolled by the URL while the user is mid-word,
  // otherwise every keystroke would push a history entry.
  const [searchDraft, setSearchDraft] = useState(current.search);
  const firstRun = useRef(true);

  const commit = useCallback((next) => {
    if (!syncUrl) { setLocal(next); return; }
    const params = new URLSearchParams(searchParams);
    const put = (key, value) => {
      if (value === '' || value === null || value === undefined) params.delete(key);
      else params.set(key, String(value));
    };
    put('search', next.search);
    put('ordering', next.ordering === defaultOrdering ? '' : next.ordering);
    put('page', next.page > 1 ? next.page : '');
    put('group_by', next.groupBy);
    filterKeys.forEach((key) => put(key, next.filters?.[key]));
    // `replace` so a listing does not bury the page the user arrived from.
    setSearchParams(params, { replace: true });
  }, [syncUrl, searchParams, setSearchParams, filterKeys, defaultOrdering]);

  // --- debounced search -----------------------------------------------------
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return undefined; }
    if (searchDraft === current.search) return undefined;
    const timer = setTimeout(
      () => commit({ ...current, search: searchDraft, page: 1 }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [searchDraft]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A change made elsewhere (Reset view, a shared link) rehydrates the box.
  useEffect(() => { setSearchDraft(current.search); }, [current.search]);

  // --- the actions a toolbar needs -----------------------------------------
  const setFilter = useCallback((key, value) => {
    const next = { ...current.filters };
    if (value === '' || value === null || value === undefined) delete next[key];
    else next[key] = value;
    commit({ ...current, filters: next, page: 1 });
  }, [current, commit]);

  const clearFilters = useCallback(
    () => commit({ ...current, filters: {}, search: '', page: 1 }),
    [current, commit],
  );

  /**
   * Three-state sort: ascending, then descending, then back to the page's own
   * default. The third click matters: it is how a user gets back to "newest
   * first" without reloading.
   */
  const toggleSort = useCallback((key) => {
    const next = current.ordering === key ? `-${key}`
      : current.ordering === `-${key}` ? defaultOrdering
        : key;
    commit({ ...current, ordering: next, page: 1 });
  }, [current, commit, defaultOrdering]);

  const sortDirection = useCallback((key) => (
    current.ordering === key ? 'asc' : current.ordering === `-${key}` ? 'desc' : null
  ), [current.ordering]);

  const reset = useCallback(() => {
    if (!syncUrl) { setLocal({ search: '', ordering: defaultOrdering, page: 1, groupBy: '', filters: {} }); return; }
    const params = new URLSearchParams(searchParams);
    [...RESERVED, ...filterKeys].forEach((key) => params.delete(key));
    setSearchParams(params, { replace: true });
  }, [syncUrl, searchParams, setSearchParams, filterKeys, defaultOrdering]);

  const activeFilterCount = Object.keys(current.filters || {}).length;

  return {
    ...current,
    searchDraft,
    setSearchDraft,
    setFilter,
    clearFilters,
    setGroupBy: (key) => commit({ ...current, groupBy: key || '', page: 1 }),
    setPage: (page) => commit({ ...current, page }),
    toggleSort,
    sortDirection,
    reset,
    activeFilterCount,
    hasActiveView: Boolean(
      current.search || activeFilterCount || current.groupBy
      || (current.ordering && current.ordering !== defaultOrdering)),
  };
}
