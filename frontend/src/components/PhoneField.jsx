import { useEffect, useMemo, useRef, useState } from 'react';
import { usePhoneInput, defaultCountries, parseCountry, FlagImage } from 'react-international-phone';
import 'react-international-phone/style.css';
import { getExampleNumber, isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';

import { useDefaultPhoneCountry } from '../hooks/useDefaultPhoneCountry.js';

const ALL_COUNTRIES = defaultCountries.map(parseCountry);

// A real mobile number for the SELECTED country, so the hint never shows a UAE
// shape on an Indian field. Falls back to no placeholder rather than a wrong one.
const _examples = {};
function examplePhone(iso2) {
  if (!(iso2 in _examples)) {
    try {
      const n = getExampleNumber(iso2.toUpperCase(), examples);
      _examples[iso2] = n ? n.formatNational().replace(/^0\s*/, '') : '';
    } catch { _examples[iso2] = ''; }
  }
  return _examples[iso2];
}

/**
 * International phone input with a SEARCHABLE country dropdown. The dial code is
 * locked in the input (only the national number is editable) - the country can
 * only be changed from the dropdown, never by typing a different code.
 * Stores the full E.164 number. Starts on the organization's country (Organization
 * Info -> Country) unless `defaultCountry` is passed explicitly.
 */
export function PhoneField({ value, onChange, defaultCountry, invalid = false }) {
  const orgCountry = useDefaultPhoneCountry();
  const startCountry = defaultCountry || orgCountry;
  const { inputValue, country, setCountry, handlePhoneValueChange, inputRef } = usePhoneInput({
    defaultCountry: startCountry,
    value: value || '',
    disableDialCodeAndPrefix: true,
    // When no national number is entered, store '' (not the bare dial code like
    // "+971") so an untouched field counts as empty/optional - not invalid.
    onChange: (data) => onChange(data.inputValue ? data.phone : ''),
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef(null);

  // `usePhoneInput` reads defaultCountry once, at init. The organization's
  // country is fetched, so on the very first field of a session it can land a
  // tick later - adopt it then. Only while the field is still empty: a number
  // already carries its own country, and a manual pick must never be undone.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || defaultCountry || value) return;
    if (!orgCountry || orgCountry === country.iso2) return;
    adopted.current = true;
    setCountry(orgCountry);
  }, [orgCountry, defaultCountry, value, country.iso2, setCountry]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const list = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!s) return ALL_COUNTRIES;
    const digits = s.replace(/\D/g, '');
    return ALL_COUNTRIES.filter((c) => c.name.toLowerCase().includes(s)
      || c.iso2.includes(s) || (digits && c.dialCode.includes(digits)));
  }, [query]);

  return (
    <div className={`pf${invalid ? ' pf--invalid' : ''}`} ref={wrap}>
      <button type="button" className="pf-btn" onClick={() => { setOpen((o) => !o); setQuery(''); }}
        aria-label="Select country">
        <FlagImage iso2={country.iso2} size="22px" />
        <span className="pf-dial">+{country.dialCode}</span>
        <span className="pf-caret" aria-hidden="true">▾</span>
      </button>
      <input ref={inputRef} className="pf-in" type="tel" value={inputValue}
        onChange={handlePhoneValueChange} placeholder={examplePhone(country.iso2)} />
      {open && (
        <div className="pf-pop">
          <input className="pf-search" autoFocus placeholder="Search country…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="pf-list">
            {list.map((c) => (
              <li key={c.iso2}>
                <button type="button" className={`pf-opt${c.iso2 === country.iso2 ? ' is-on' : ''}`}
                  onClick={() => { setCountry(c.iso2); setOpen(false); inputRef.current?.focus(); }}>
                  <FlagImage iso2={c.iso2} size="20px" />
                  <span className="pf-opt-name">{c.name}</span>
                  <span className="pf-opt-dial">+{c.dialCode}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="pf-empty">No country found</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Valid phone for its country (any line type). Blank = valid (optional fields). */
export function isPhoneValid(value) {
  const v = (value || '').trim();
  if (!v) return true;
  try { return isValidPhoneNumber(v); } catch { return false; }
}

const NON_MOBILE_TYPES = new Set(['FIXED_LINE', 'PREMIUM_RATE', 'TOLL_FREE', 'VOIP', 'PAGER', 'UAN', 'SHARED_COST']);
/** Valid MOBILE number for its country - rejects landlines. Blank = valid. */
export function isMobileValid(value) {
  const v = (value || '').trim();
  if (!v) return true;
  try {
    if (!isValidPhoneNumber(v)) return false;
    return !NON_MOBILE_TYPES.has(parsePhoneNumber(v).getType());
  } catch { return false; }
}
