import { useEffect, useState } from 'react';

import { taxRatesApi } from '../services/settingsService.js';

// Cached so the modals get the configured default tax % instantly once loaded.
let _cache = null;

/**
 * The organization's configured default tax rate as a percentage (e.g. 5 for
 * 5%), from System Settings → Tax Rates (the `is_default` rate). Used to
 * pre-fill the tax field when creating a new service / add-on; editable after.
 */
export function useDefaultTaxPercent() {
  const [pct, setPct] = useState(_cache ?? 0);
  useEffect(() => {
    if (_cache != null) { setPct(_cache); return; }
    taxRatesApi.list()
      .then((rows) => {
        const list = rows?.results || rows || [];
        const def = list.find((r) => r.is_default) || list[0];
        const rate = def ? Number(def.rate) : 0;
        _cache = Number.isFinite(rate) ? Math.round(rate * 10000) / 100 : 0;   // 0.05 -> 5
        setPct(_cache);
      })
      .catch(() => { _cache = 0; setPct(0); });
  }, []);
  return pct;
}
