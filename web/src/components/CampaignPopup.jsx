import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { I18n } from '../i18n/client.jsx';

/**
 * The promotional card a campaign appears as.
 *
 * WHAT IT DECIDES
 *   Only how often to show a campaign the server already said this visitor may
 *   see. That is the one part the server cannot answer, because it depends on
 *   what this particular browser has dismissed, and remembering that here keeps
 *   it out of any record of the person.
 *
 * WHAT IT NEVER DECIDES
 *   Whether a campaign is live, who it is for, or what it is worth. A campaign
 *   advertises a promo code; the promo engine still validates it at booking.
 *
 * Only the highest-priority campaign opens. The rest are queued and offered one
 * at a time, so two popups can never stack.
 */

const STORE_PREFIX = 'cb-campaign:';

/** Browser storage is a convenience here; a refusal must not break the page. */
function readMark(id) {
  try {
    return window.localStorage.getItem(STORE_PREFIX + id)
      || window.sessionStorage.getItem(STORE_PREFIX + id);
  } catch {
    return null;
  }
}

function writeMark(id, frequency) {
  try {
    const now = new Date().toISOString();
    if (frequency === 'session') window.sessionStorage.setItem(STORE_PREFIX + id, now);
    if (frequency === 'daily' || frequency === 'once') {
      window.localStorage.setItem(STORE_PREFIX + id, now);
    }
  } catch {
    /* private mode: the campaign simply shows again, which is not a failure */
  }
}

/**
 * Whether this browser should see the campaign now.
 *
 * `every_visit` and `until_closed` both mean "show it again on the next page";
 * the difference is only that `until_closed` keeps it up while you navigate,
 * which the site handles by not marking it dismissed for the session.
 */
function shouldShow(campaign) {
  const frequency = campaign.frequency || 'session';
  if (frequency === 'every_visit' || frequency === 'until_closed') return true;

  const mark = readMark(campaign.id);
  if (!mark) return true;
  if (frequency === 'once') return false;
  if (frequency === 'session') return false;          // sessionStorage cleared it already
  if (frequency === 'daily') {
    const seen = new Date(mark);
    return Number.isNaN(seen.getTime())
      || seen.toDateString() !== new Date().toDateString();
  }
  return true;
}

/** Counting is best-effort and never awaited: a popup must not wait on it. */
function count(id, event) {
  try {
    const body = JSON.stringify({ id, event });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/campaign-event', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/campaign-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics is never worth an error in front of a customer */
  }
}

export default function CampaignPopup({ locale, ...props }) {
  return <I18n locale={locale}><Popup {...props} /></I18n>;
}

function Popup({ campaigns = [] }) {
  const { t } = useTranslation();
  // The queue is fixed on mount: the server already ordered it by priority, and
  // re-sorting here would only risk disagreeing with it.
  const [queue] = useState(() => campaigns.filter(shouldShow));
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const panel = useRef(null);
  const returnTo = useRef(null);

  const current = queue[index] || null;

  // A moment's delay so the card arrives after the page, not on top of it.
  useEffect(() => {
    if (!current) return undefined;
    const timer = window.setTimeout(() => setOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, [current]);

  useEffect(() => {
    if (!open || !current) return undefined;
    count(current.id, 'impression');
    returnTo.current = document.activeElement;
    panel.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open, current]);

  const close = useCallback((reason = 'dismiss') => {
    if (!current) return;
    if (reason === 'dismiss') count(current.id, 'dismiss');
    if (current.frequency !== 'until_closed' || reason === 'dismiss') {
      writeMark(current.id, current.frequency);
    }
    setOpen(false);
    // Focus goes back where it came from rather than to the top of the page.
    try { returnTo.current?.focus?.(); } catch { /* element may be gone */ }
    // Offer the next campaign, if there is one, rather than stacking them.
    window.setTimeout(() => setIndex((i) => i + 1), 400);
  }, [current]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && current?.dismissible !== false) close();
      // A dialog keeps the keyboard inside it; without this, tabbing walks the
      // page behind the card while it is covered.
      if (e.key === 'Tab' && panel.current) {
        const focusable = panel.current.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close, current]);

  if (!current || !open) return null;

  const art = current.image || null;
  const mobileArt = current.mobile_image || null;
  const hasArt = Boolean(art || mobileArt);
  // A campaign with artwork and nothing else is the artwork; a campaign with
  // words as well gets the split layout.
  const wordy = Boolean(current.title || current.subtitle || current.description
    || current.cta_label);

  function follow(url, label) {
    if (!url) return;
    count(current.id, 'click');
    close('click');
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    else window.location.assign(url);
    return label;
  }

  return (
    <div
      className="cmp__scrim"
      onClick={() => { if (current.dismissible !== false) close(); }}
    >
      <div
        className={`cmp${hasArt && wordy ? ' cmp--split' : ''}${hasArt && !wordy ? ' cmp--art' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`cmp-title-${current.id}`}
        tabIndex={-1}
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        {current.dismissible !== false && (
          <button type="button" className="cmp__close" onClick={() => close()}
            aria-label={t('common.close')}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}

        {hasArt && (
          <picture className="cmp__art">
            {mobileArt && <source media="(max-width: 640px)" srcSet={mobileArt.url} />}
            {/* Empty alt when the artwork is decorative, so a screen reader is
                not read a filename it cannot use. */}
            <img
              src={(art || mobileArt).url}
              alt={current.alt_text || art?.alt || ''}
              loading="eager"
            />
          </picture>
        )}

        {wordy && (
          <div className="cmp__body">
            {current.promo_code && (
              <span className="cmp__code">{current.promo_code}</span>
            )}
            <h2 className="cmp__title" id={`cmp-title-${current.id}`}>{current.title}</h2>
            {current.subtitle && <p className="cmp__sub">{current.subtitle}</p>}
            {current.description && <p className="cmp__desc">{current.description}</p>}

            <div className="cmp__actions">
              {current.cta_label && current.cta_url && (
                <button type="button" className="btn btn-amber"
                  onClick={() => follow(current.cta_url)}>
                  {current.cta_label}
                </button>
              )}
              {current.secondary_cta_label && current.secondary_cta_url && (
                <button type="button" className="btn btn-outline"
                  onClick={() => follow(current.secondary_cta_url)}>
                  {current.secondary_cta_label}
                </button>
              )}
            </div>
          </div>
        )}

        {/* An artwork-only campaign still needs a name for assistive tech. */}
        {!wordy && (
          <h2 className="sr-only" id={`cmp-title-${current.id}`}>
            {current.alt_text || 'Promotion'}
          </h2>
        )}
      </div>
    </div>
  );
}
