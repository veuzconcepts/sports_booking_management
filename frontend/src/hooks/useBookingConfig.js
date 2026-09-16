import { useEffect, useState } from 'react';

import { bookingConfigApi } from '../services/settingsService.js';

// Cached so every form doesn't refetch the (rarely-changing) rules.
let _cache = null;

/**
 * The Booking Configuration (per-channel email/phone required + unique). Returns
 * the full config object (or null until loaded), plus a `rulesFor(channel)` helper
 * giving {email_required, phone_required, email_unique, phone_unique} for
 * 'website' | 'admin' | 'walkin'.
 */
export function useBookingConfig() {
  const [cfg, setCfg] = useState(_cache);
  useEffect(() => {
    if (_cache) { setCfg(_cache); return; }
    bookingConfigApi.get().then((c) => { _cache = c; setCfg(c); }).catch(() => {});
  }, []);

  const rulesFor = (channel) => {
    const ch = ['website', 'admin', 'walkin'].includes(channel) ? channel : 'admin';
    return {
      email_required: !!cfg?.[`${ch}_email_required`],
      phone_required: !!cfg?.[`${ch}_phone_required`],
      email_unique: !!cfg?.[`${ch}_email_unique`],
      phone_unique: !!cfg?.[`${ch}_phone_unique`],
    };
  };
  return { cfg, rulesFor };
}
