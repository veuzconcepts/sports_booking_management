import { useEffect, useState } from 'react';

import { clubsApi } from '../services/clubsService.js';
import { facilityTypesApi } from '../services/facilitiesService.js';

/**
 * Reference lists that listing-page filters need (clubs, facility types).
 *
 * Fetched once per session and shared, so opening five listing pages does not
 * re-request the same two short lists five times. These are small, slow-moving
 * catalogues; anything larger belongs in a searchable picker instead.
 */
const cache = { clubs: null, facilityTypes: null };
let inflight = null;

export function useFilterOptions() {
  const [data, setData] = useState(() => ({
    clubs: cache.clubs || [],
    facilityTypes: cache.facilityTypes || [],
  }));

  useEffect(() => {
    if (cache.clubs && cache.facilityTypes) return;
    inflight = inflight || Promise.all([
      clubsApi.list({ page_size: 200, is_active: 'true' })
        .then((d) => d.results || d).catch(() => []),
      facilityTypesApi.list({ page_size: 200, is_active: 'true' })
        .then((d) => d.results || d).catch(() => []),
    ]);
    inflight.then(([clubs, facilityTypes]) => {
      cache.clubs = clubs;
      cache.facilityTypes = facilityTypes;
      setData({ clubs, facilityTypes });
    });
  }, []);

  return data;
}

/** [{value, label}] for a Select-style filter. */
export function asOptions(rows, labelKey = 'name') {
  return (rows || []).map((r) => ({ value: r.id, label: r[labelKey] }));
}
