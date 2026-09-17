import { useEffect, useMemo, useRef, useState } from 'react';
import { usePhoneInput, defaultCountries, parseCountry, FlagImage } from 'react-international-phone';
import 'react-international-phone/style.css';
import { getExampleNumber } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';

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
 * locked in the input (only the national number is typed) - the country changes
 * only from the dropdown. Stores the full E.164 number.
 */
export default function PhoneField({ value, onChange, defaultCountry = 'ae', invalid = false, disabled = false }) {
  const { inputValue, country, setCountry, handlePhoneValueChange, inputRef } = usePhoneInput({
    defaultCountry,
    value: value || '',
    disableDialCodeAndPrefix: true,
    onChange: (data) => onChange(data.phone),
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef(null);

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
    <div className={`pf${invalid ? ' pf--invalid' : ''}${disabled ? ' pf--disabled' : ''}`} ref={wrap}>
      <button type="button" className="pf-btn" disabled={disabled}
        onClick={() => { setOpen((o) => !o); setQuery(''); }} aria-label="Select country">
        <FlagImage iso2={country.iso2} size="24px" />
        <span className="pf-dial">+{country.dialCode}</span>
        <span className="pf-caret" aria-hidden="true">▾</span>
      </button>
      <input ref={inputRef} className="pf-in" type="tel" value={inputValue}
        onChange={handlePhoneValueChange} placeholder={examplePhone(country.iso2)} disabled={disabled} />
      {open && (
        <div className="pf-pop">
          <input className="pf-search" autoFocus placeholder="Search country…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="pf-list">
            {list.map((c) => (
              <li key={c.iso2}>
                <button type="button" className={`pf-opt${c.iso2 === country.iso2 ? ' is-on' : ''}`}
                  onClick={() => { setCountry(c.iso2); setOpen(false); inputRef.current?.focus(); }}>
                  <FlagImage iso2={c.iso2} size="22px" />
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
