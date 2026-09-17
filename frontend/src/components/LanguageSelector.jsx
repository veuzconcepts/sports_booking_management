import { useEffect, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useLanguage } from '../i18n/LanguageProvider.jsx';
import './languageSelector.css';

/**
 * The one language switcher, used in the topbar and on the sign-in page.
 *
 * It offers only languages an administrator has enabled, showing each in its
 * own script, because someone looking for Arabic is looking for "العربية" and
 * not for "Arabic". Choosing takes effect immediately, with no reload.
 *
 * Renders nothing when only one language is available: a menu with a single
 * item is clutter, not a choice.
 */
export function LanguageSelector({ variant = 'button' }) {
  const { t } = useTranslation('navigation');
  const { language, languages, choose } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (languages.length < 2) return null;

  const active = languages.find((l) => l.code === language);

  return (
    <div className={`lang lang--${variant}`} ref={wrap}>
      <button
        type="button"
        className="lang__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('topbar.changeLanguage')}
        onClick={() => setOpen((o) => !o)}
      >
        <Globe size={15} />
        <span className="lang__label">{active?.native_name || language}</span>
      </button>

      {open && (
        <ul className="lang__menu" role="listbox" aria-label={t('topbar.language')}>
          {languages.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === language}
                className={`lang__option${l.code === language ? ' is-on' : ''}`}
                lang={l.code}
                onClick={async () => { await choose(l.code); setOpen(false); }}
              >
                {/* The row keeps the interface's direction so every option has
                    the same shape; only the name itself follows its language. */}
                <span className="lang__native">
                  <bdi dir={l.direction}>{l.native_name || l.name}</bdi>
                </span>
                <span className="lang__tick">
                  {l.code === language && <Check size={13} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
