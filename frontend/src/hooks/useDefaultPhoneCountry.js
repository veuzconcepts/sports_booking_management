import { useEffect, useState } from 'react';

import { organizationApi } from '../services/settingsService.js';
import { countryCodeFromName } from '../utils/countries.js';

// Last-resort default when the organization has no country set, or the user
// cannot read organization settings. Only ever seen before the org is filled in.
export const FALLBACK_PHONE_COUNTRY = 'ae';

// Shared across every phone field so the organization is fetched once, and so a
// field mounted later gets the right flag on its FIRST render.
let _cache = null;
let _inflight = null;

/**
 * The country a phone input should start on: the one configured in
 * Organization Info. Set the organization to India and new clubs, customers and
 * bookings all offer +91 instead of +971.
 */
export function useDefaultPhoneCountry() {
  const [code, setCode] = useState(_cache ?? '');

  useEffect(() => {
    if (_cache != null) return;
    _inflight = _inflight || organizationApi.get()
      .then((d) => countryCodeFromName(d?.country))
      .catch(() => '');           // no permission / offline - use the fallback
    _inflight.then((c) => { _cache = c || FALLBACK_PHONE_COUNTRY; setCode(_cache); });
  }, []);

  return code || FALLBACK_PHONE_COUNTRY;
}

/** Test seam: forget the cached organization country. */
export function _resetPhoneCountryCache() {
  _cache = null;
  _inflight = null;
}
