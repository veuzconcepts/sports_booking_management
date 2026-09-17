import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isHexColour, normaliseColour } from './tokens.js';

/**
 * One themeable colour: a swatch that opens the platform picker, plus the hex
 * for anyone who has a brand value to paste.
 *
 * The text field keeps whatever is being typed so a half-finished value is not
 * snatched away mid-keystroke; it only reports upward once it is a real colour,
 * and shows an error rather than silently discarding a typo.
 */
export function ColorField({ label, value, defaultValue, onChange, disabled = false }) {
  const { t } = useTranslation('organization');
  const [draft, setDraft] = useState(value);

  // Follow the value when it changes from outside (a preset was applied, or
  // the theme was reset), but never while the field is being edited into shape.
  useEffect(() => { setDraft(value); }, [value]);

  const valid = isHexColour(draft);
  const isChanged = normaliseColour(value) !== normaliseColour(defaultValue);

  function commit(next) {
    setDraft(next);
    if (isHexColour(next)) onChange(normaliseColour(next));
  }

  return (
    <div className="th-field">
      <label className="th-field__label" htmlFor={`color-${label}`}>{label}</label>
      <div className={`th-field__row${valid ? '' : ' th-field__row--invalid'}`}>
        <input
          className="th-swatch"
          type="color"
          value={isHexColour(value) ? normaliseColour(value) : '#000000'}
          onChange={(e) => commit(e.target.value)}
          disabled={disabled}
          aria-label={t('theme.pickColour', { field: label })}
        />
        <input
          id={`color-${label}`}
          className="th-hex"
          value={draft || ''}
          onChange={(e) => commit(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          inputMode="text"
          placeholder="#2563eb"
        />
        {isChanged && !disabled && (
          <button
            type="button"
            className="icon-btn th-field__reset"
            title={t('theme.resetField')}
            onClick={() => commit(defaultValue)}
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {!valid && <div className="form-error">{t('theme.invalidColour')}</div>}
    </div>
  );
}
