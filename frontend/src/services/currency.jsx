import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { currencyApi } from './settingsService.js';

// Static symbol map (mirrors the backend CURRENCIES list); refined from the API.
// English/Latin symbols only - Arabic glyphs return with an Arabic-language mode.
const SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', AED: 'AED', SAR: 'SR', QAR: 'QR',
  BHD: 'BD', KWD: 'KD', OMR: 'OMR', JPY: '¥', KRW: '₩', INR: '₹', PKR: '₨',
  AUD: 'A$', CAD: 'C$',
};

// Minor-unit decimal places per currency (ISO 4217; mirrors the backend, refined
// from the API). Most are 2; the GCC dinars BHD/KWD/OMR use 3; JPY/KRW use 0.
const DECIMALS = { BHD: 3, KWD: 3, OMR: 3, JPY: 0, KRW: 0 };
const DEFAULT_DECIMALS = 2;

// Codes whose symbol renders via a custom glyph font (see .aed-symbol / @font-face).
// AED's value is intentionally the text "AED": the aed font blanks A & E (zero-width
// glyphs) and draws D as the new Dirham symbol, so "AED" collapses to one glyph when
// the .aed-symbol font is applied (and degrades to plain "AED" text without it).
const GLYPH_FONT_CODES = { AED: 'aed-symbol' };

// Selectable currency codes (for forms that let you override the currency).
export const CURRENCY_OPTIONS = Object.keys(SYMBOLS).map((c) => ({ value: c, label: c }));

// Module-level singleton so the plain formatMoney() works outside React too.
let _code = 'USD';
let _symbols = { ...SYMBOLS };
let _decimals = { ...DECIMALS };

export function currencySymbol(code) {
  return _symbols[code] || _symbols[_code] || '$';
}

// Decimal places for a currency (default 2; e.g. BHD/KWD/OMR -> 3).
export function currencyDecimals(code) {
  const d = _decimals[code ?? _code];
  return Number.isInteger(d) ? d : DEFAULT_DECIMALS;
}

/**
 * Format an amount with the active system currency, or a per-record override.
 * Decimal places follow the currency (most 2; GCC dinars 3).
 * formatMoney(120) -> "AED 120.00"  ·  formatMoney(120, 'BHD') -> "BD 120.000"
 */
export function formatMoney(amount, codeOverride) {
  const code = codeOverride || _code;
  const sym = currencySymbol(code);
  const d = currencyDecimals(code);
  const n = Number(amount || 0).toLocaleString(undefined, {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
  return `${sym} ${n}`;
}

/**
 * Render a currency symbol, using the glyph font where one exists (e.g. the new
 * AED Dirham symbol). Falls back to plain text otherwise.
 *   <CurrencySymbol code="AED" />  ->  <span class="aed-symbol">AED</span>
 */
export function CurrencySymbol({ code }) {
  const c = code || _code;
  const cls = GLYPH_FONT_CODES[c];
  const sym = currencySymbol(c);
  return cls ? <span className={cls}>{sym}</span> : <>{sym}</>;
}

/** Amount + symbol as JSX, so the glyph font applies (use where formatMoney's
 *  plain string can't carry styling). <Money amount={120} code="AED" /> */
export function Money({ amount, code }) {
  const c = code || _code;
  const d = currencyDecimals(c);
  const n = Number(amount || 0).toLocaleString(undefined, {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
  return <><CurrencySymbol code={c} /> {n}</>;
}

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  const [code, setCode] = useState(_code);

  const reload = useCallback(async () => {
    try {
      const d = await currencyApi.get();
      if (Array.isArray(d.choices)) {
        d.choices.forEach((c) => {
          if (c.symbol) _symbols[c.code] = c.symbol;
          if (Number.isInteger(c.decimals)) _decimals[c.code] = c.decimals;
        });
      }
      _code = d.currency || _code;
      setCode(_code);           // re-render the app subtree with the new currency
    } catch {
      /* keep the USD fallback if the user can't read settings */
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <CurrencyContext.Provider value={{ code, symbol: currencySymbol(code), formatMoney, reload }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext)
    || { code: _code, symbol: currencySymbol(_code), formatMoney, reload: () => {} };
}
