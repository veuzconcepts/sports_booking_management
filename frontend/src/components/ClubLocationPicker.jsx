import { useEffect, useRef } from 'react';
import { MapPin, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FormField } from './FormField.jsx';
import { loadGoogleMaps, googleMapsKey, parseAddressComponents } from '../utils/googleMaps.js';

const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Club "Address Selection" - a two-pane block: address fields on the left and
 * a live Google map on the right. Search an address, drag the pin, or click the
 * map; the latitude/longitude and the address/city fill automatically (reverse
 * geocoded through the Maps API). Manual lat/lng entry stays available, and the
 * whole thing degrades to plain fields when no Maps key is configured.
 *
 *   - latitude / longitude       current coordinates (strings or numbers)
 *   - address / city             current address fields
 *   - onChange({ latitude, longitude })
 *   - onAddress(value) / onCity(value)
 */
export function ClubLocationPicker({
  latitude, longitude, address, city, onChange, onAddress, onCity,
}) {
  const { t } = useTranslation('clubs');
  const hasKey = Boolean(googleMapsKey());
  const inputRef = useRef(null);
  const mapEl = useRef(null);
  const mapObj = useRef(null);
  const marker = useRef(null);

  useEffect(() => {
    if (!hasKey) return undefined;
    let cancelled = false;
    loadGoogleMaps().then((maps) => {
      if (cancelled || !maps || !mapEl.current) return;
      const start = latitude && longitude
        ? { lat: Number(latitude), lng: Number(longitude) }
        : { lat: 25.2048, lng: 55.2708 };   // Dubai default
      const map = new maps.Map(mapEl.current, { center: start, zoom: latitude ? 14 : 10, mapId: 'CLUB' });
      mapObj.current = map;
      const m = new maps.Marker({ position: start, map, draggable: true });
      marker.current = m;

      const geocoder = new maps.Geocoder();
      const fill = (parsed) => {
        if (parsed?.line1) onAddress?.(parsed.line1);
        if (parsed?.city) onCity?.(parsed.city);
      };
      const reverse = (loc) => geocoder.geocode(
        { location: { lat: loc.lat(), lng: loc.lng() } },
        (results, status) => {
          if (status === 'OK' && results && results[0]) {
            fill(parseAddressComponents(results[0].address_components || []));
          }
        },
      );
      const setFrom = (loc, doReverse = true) => {
        onChange({ latitude: round(loc.lat()), longitude: round(loc.lng()) });
        if (doReverse) reverse(loc);
      };
      m.addListener('dragend', () => setFrom(m.getPosition()));
      map.addListener('click', (e) => { m.setPosition(e.latLng); setFrom(e.latLng); });

      if (inputRef.current && maps.places) {
        const ac = new maps.places.Autocomplete(inputRef.current, {
          fields: ['geometry', 'address_components', 'name'],
        });
        ac.addListener('place_changed', () => {
          const place = ac.getPlace();
          if (!place.geometry) return;
          const loc = place.geometry.location;
          map.panTo(loc); map.setZoom(15); m.setPosition(loc);
          setFrom(loc, false);
          fill(parseAddressComponents(place.address_components || []));
        });
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey]);

  // Keep the pin in sync when lat/lng are set/changed (e.g. manual entry, edit).
  useEffect(() => {
    if (mapObj.current && marker.current && latitude && longitude) {
      const p = { lat: Number(latitude), lng: Number(longitude) };
      marker.current.setPosition(p);
      mapObj.current.panTo(p);
    }
  }, [latitude, longitude]);

  return (
    <div className="club-loc">
      <div className="club-loc__head"><MapPin size={18} /> {t('addressSelection')}</div>
      <div className="club-loc__grid">
        <div className="club-loc__form">
          {hasKey && (
            <div className="club-loc__search">
              <Search size={15} />
              <input ref={inputRef} placeholder={t('searchAddress')} aria-label={t('searchAddress2')} />
            </div>
          )}
          <FormField label={t('address')}>
            <input className="form-input" value={address ?? ''} onChange={(e) => onAddress?.(e.target.value)} />
          </FormField>
          <FormField label={t('city')}>
            <input className="form-input" value={city ?? ''} onChange={(e) => onCity?.(e.target.value)} />
          </FormField>
          <div className="row">
            <div className="col"><FormField label={t('latitude')}>
              <input className="form-input" type="number" step="0.000001" placeholder="25.204800"
                value={latitude ?? ''} onChange={(e) => onChange({ latitude: e.target.value, longitude })} />
            </FormField></div>
            <div className="col"><FormField label={t('longitude')}>
              <input className="form-input" type="number" step="0.000001" placeholder="55.270800"
                value={longitude ?? ''} onChange={(e) => onChange({ latitude, longitude: e.target.value })} />
            </FormField></div>
          </div>
          {!hasKey && (
            <p className="club-loc__note">{t('addGoogleMapsKeySearch')}</p>
          )}
        </div>
        {hasKey
          ? <div className="club-loc__map"><div ref={mapEl} /></div>
          : <div className="club-loc__manual"><MapPin size={26} /><span>{t('liveMapAppearsHereOnce')}</span></div>}
      </div>
    </div>
  );
}
