/**
 * Lazy loader for the Google Maps JS API (Maps + Places). Environment-driven -
 * the key comes from VITE_GOOGLE_MAPS_API_KEY and is never hardcoded. Resolves
 * to `window.google.maps` when ready, or `null` when no key is configured or the
 * script fails to load - callers then fall back to manual address entry.
 */
let _promise = null;

export function googleMapsKey() {
  return import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
}

export function loadGoogleMaps() {
  const key = googleMapsKey();
  if (!key) return Promise.resolve(null);
  if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
  if (_promise) return _promise;

  _promise = new Promise((resolve) => {
    const cbName = '__gmapsReady';
    window[cbName] = () => resolve((window.google && window.google.maps) || null);
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + `&libraries=places&callback=${cbName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return _promise;
}

/** Parse Google address_components into our Address fields. */
export function parseAddressComponents(components = []) {
  const get = (type) => components.find((c) => c.types.includes(type))?.long_name || '';
  const line1 = [get('street_number'), get('route')].filter(Boolean).join(' ')
    || get('premise') || get('sublocality') || '';
  return {
    line1,
    city: get('locality') || get('postal_town') || get('administrative_area_level_2'),
    state: get('administrative_area_level_1'),
    country: get('country'),
    postal_code: get('postal_code'),
  };
}
