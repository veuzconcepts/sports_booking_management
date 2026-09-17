import { useEffect, useRef } from 'react';
import { ChevronDown, LayoutDashboard, Settings, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { applyTheme } from './tokens.js';

/**
 * A miniature of the application under a theme that has not been saved.
 *
 * The variables are written to this container, not to the document, so nothing
 * an administrator tries here reaches the interface around them or anyone
 * else's session. It is the same `applyTheme` the provider uses, at a different
 * scope, so the preview cannot drift from what saving would produce.
 */
export function ThemePreview({ theme }) {
  const { t } = useTranslation('organization');
  const scope = useRef(null);

  useEffect(() => { applyTheme(scope.current, theme); }, [theme]);

  return (
    <div className="th-preview" ref={scope} aria-hidden="true">
      <div className="th-preview__chrome">
        <div className="th-preview__header">
          <span className="th-preview__brand">{t('theme.preview.brand')}</span>
          <span className="th-preview__avatar" />
        </div>
        <div className="th-preview__body">
          <nav className="th-preview__sidebar">
            <span className="th-preview__nav is-active">
              <LayoutDashboard size={13} /> {t('theme.preview.dashboard')}
            </span>
            <span className="th-preview__nav">
              <Users size={13} /> {t('theme.preview.customers')}
            </span>
            <span className="th-preview__nav">
              <Settings size={13} /> {t('theme.preview.settings')}
            </span>
          </nav>

          <div className="th-preview__main">
            <div className="th-preview__card">
              <div className="th-preview__card-title">{t('theme.preview.cardTitle')}</div>

              <div className="th-preview__controls">
                <button type="button" className="th-preview__btn">
                  {t('theme.preview.primaryAction')}
                </button>
                <span className="th-preview__link">{t('theme.preview.link')}</span>
              </div>

              <div className="th-preview__input">
                {t('theme.preview.field')}
                <ChevronDown size={12} />
              </div>

              <table className="th-preview__table">
                <thead>
                  <tr>
                    <th>{t('theme.preview.columnName')}</th>
                    <th>{t('theme.preview.columnStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t('theme.preview.rowOne')}</td>
                    <td><span className="th-preview__badge is-ok">{t('theme.preview.confirmed')}</span></td>
                  </tr>
                  <tr className="is-selected">
                    <td>{t('theme.preview.rowTwo')}</td>
                    <td><span className="th-preview__badge is-warn">{t('theme.preview.pending')}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
