import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { I18n } from '../i18n/client.jsx';
import { intlLocale } from '../i18n/index.js';

import {
  CardForm,
  blankCard,
  cardRequest,
  copyLink,
  formatMoney,
  shareLink,
  shareTone,
  useCountdown,
} from './CheckoutPayment.jsx';

/**
 * The two public split-payment screens.
 *
 * `SharePay` is what a friend opens. It must be safe in the hands of whoever the
 * link was forwarded to, so it renders only what the backend chose to send:
 * the club, the facility, the date and time, and one amount. There is no way to
 * change the amount here because there is no amount to change - the server
 * decides what this link owes and ignores anything the page might claim.
 *
 * `SplitProgress` is the organizer's view. It re-reads the links this browser
 * saved at checkout, because the server keeps only digests and genuinely cannot
 * show them again.
 */

const Pin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.6" />
  </svg>
);

const Clock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);

const Court = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18M12 4v16" />
  </svg>
);

function longDate(value, locale) {
  if (!value) return '';
  const when = new Date(`${value}T00:00:00`);
  if (Number.isNaN(when.getTime())) return value;
  return when.toLocaleDateString(intlLocale(locale),
    { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeRange(start, end) {
  return [start, end].filter(Boolean).join(' - ');
}

function BookingFacts({ booking }) {
  const { t, i18n } = useTranslation();
  return (
    <ul className="sp__facts">
      <li><span className="sp__fact-ic"><Pin /></span>
        <div><span>{t('pay.club')}</span><strong>{booking.club}</strong>
          {booking.club_city && <em>{booking.club_city}</em>}</div></li>
      <li><span className="sp__fact-ic"><Court /></span>
        <div><span>{t('pay.facility')}</span><strong>{booking.facility}</strong></div></li>
      <li><span className="sp__fact-ic"><Clock /></span>
        <div><span>{t('pay.when')}</span><strong>{longDate(booking.date, i18n.language)}</strong>
          <em><bdi>{timeRange(booking.time, booking.end_time)}</bdi></em></div></li>
    </ul>
  );
}

function Shell({ title, lead, children }) {
  return (
    <div className="sp">
      <div className="sp__card">
        <h1 className="sp__title">{title}</h1>
        {lead && <p className="sp__lead">{lead}</p>}
        {children}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// A friend's payment page
// --------------------------------------------------------------------------- //
function SharePayBody({ token }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [card, setCard] = useState(blankCard());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/split?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({ loading: false, data: null,
            error: body?.detail || t('pay.invalidBody') });
        } else {
          setState({ loading: false, data: body, error: '' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, data: null,
            error: t('errors.paymentUnreachable') });
        }
      });
    return () => { cancelled = true; };
  }, [token]);

  const share = state.data;
  const countdown = useCountdown(share?.expires_at);

  const pay = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/split?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // No amount is sent. What this link owes is the backend's decision.
        body: JSON.stringify({ card: cardRequest(card) }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.status === 'paid') setReceipt(body);
      else setError(body?.detail || t('errors.paymentFailed'));
    } catch {
      setError(t('errors.paymentUnreachable'));
    } finally { setBusy(false); }
  };

  if (state.loading) {
    return (
      <Shell title={t('pay.loading')}>
        <p className="sp__muted">{t('pay.oneMoment')}</p>
      </Shell>
    );
  }
  if (state.error || !share) {
    return (
      <Shell title={t('pay.invalidTitle')}
        lead={state.error || t('pay.invalidBody')} />
    );
  }
  if (receipt) {
    return (
      <Shell title={t('pay.receivedTitle')}
        lead={t('pay.receivedLead',
          { amount: formatMoney(receipt.amount, receipt.currency) })}>
        <BookingFacts booking={share.booking} />
        <p className="sp__receipt">
          {t('pay.receiptLine', { reference: receipt.reference })}
          {receipt.card_last4 ? ` · ${receipt.card_brand || 'card'} ····${receipt.card_last4}` : ''}
        </p>
      </Shell>
    );
  }
  if (share.no_longer_required) {
    return (
      <Shell title={t('pay.notRequiredTitle')} lead={t('pay.notRequiredBody')}>
        <BookingFacts booking={share.booking} />
      </Shell>
    );
  }
  if (!share.payable) {
    const tone = shareTone(share.status);
    const reason = share.status === 'paid'
      ? t('pay.alreadyPaidBody')
      : share.split_status === 'expired'
        ? t('pay.expiredBody')
        : t('pay.inactiveBody');
    return (
      <Shell
        title={t(share.status === 'paid' ? 'pay.alreadyPaidTitle' : 'pay.linkClosedTitle')}
        lead={reason}
      >
        <BookingFacts booking={share.booking} />
      </Shell>
    );
  }

  return (
    <Shell
      title={t('pay.contributingTitle')}
      lead={share.name
        ? t('pay.contributingLead', { name: share.name })
        : t('pay.contributingLeadAnon')}
    >
      <BookingFacts booking={share.booking} />
      <div className="sp__amount">
        <span>{t('pay.yourShare')}</span>
        <strong><bdi>{formatMoney(share.amount, share.currency)}</bdi></strong>
      </div>
      {countdown && (
        <p className="sp__clock"><Clock /> {t('pay.within', { time: countdown })}</p>
      )}
      {share.payment?.card_enabled ? (
        <>
          <CardForm card={card} setCard={setCard} config={share.payment} disabled={busy} />
          {error && <p className="sp__error" role="alert">{error}</p>}
          <button type="button" className="sp__pay" disabled={busy} onClick={pay}>
            {busy ? t('pay.paying')
              : t('pay.payAmount', { amount: formatMoney(share.amount, share.currency) })}
          </button>
        </>
      ) : (
        <p className="sp__error">{t('pay.unavailable')}</p>
      )}
    </Shell>
  );
}

// --------------------------------------------------------------------------- //
// The organizer's progress page
// --------------------------------------------------------------------------- //
function SplitProgressBody({ token }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [links, setLinks] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [payingRemaining, setPayingRemaining] = useState(false);
  const [card, setCard] = useState(blankCard());

  const load = () => fetch(`/api/split?scope=manage&token=${encodeURIComponent(token)}`)
    .then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setState({ loading: false, data: null,
          error: body?.detail || t('pay.invalidBody') });
      } else {
        setState({ loading: false, data: body, error: '' });
      }
    })
    .catch(() => setState({ loading: false, data: null,
      error: t('progress.unreachable') }));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  // The links this browser saved at checkout. The server keeps only digests, so
  // this is the only place they can come from; a different device legitimately
  // sees none and uses "New link" instead.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`split:${token}`);
      if (saved) setLinks(JSON.parse(saved).links || {});
    } catch { /* storage unavailable: fall back to reissuing links */ }
  }, [token]);

  const rememberLink = (shareId, url) => {
    const next = { ...links, [String(shareId)]: url };
    setLinks(next);
    try {
      window.localStorage.setItem(`split:${token}`,
        JSON.stringify({ links: next, saved: Date.now() }));
    } catch { /* nothing to do: the link is on screen */ }
  };

  const act = async (body, { after } = {}) => {
    setBusy(body.action); setError('');
    try {
      const response = await fetch(
        `/api/split?scope=manage&token=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.detail || t('progress.actionFailed'));
        return null;
      }
      if (after) after(data);
      else if (data?.shares) setState((current) => ({ ...current, data }));
      else await load();
      return data;
    } catch {
      setError(t('progress.unreachable'));
      return null;
    } finally { setBusy(''); }
  };

  const split = state.data;
  const countdown = useCountdown(split?.expires_at);

  if (state.loading) {
    return (
      <Shell title={t('progress.loading')}>
        <p className="sp__muted">{t('pay.oneMoment')}</p>
      </Shell>
    );
  }
  if (state.error || !split) {
    return <Shell title={t('pay.invalidTitle')} lead={state.error} />;
  }

  const outstanding = Number(split.outstanding || 0);
  const open = split.status === 'active';

  return (
    <div className="sp sp--wide">
      <div className="sp__card">
        <h1 className="sp__title">{t('progress.title')}</h1>
        <BookingFacts booking={split.booking} />

        <div className="sp__totals">
          <div><span>{t('progress.total')}</span><strong><bdi>{formatMoney(split.total, split.currency)}</bdi></strong></div>
          <div><span>{t('progress.paid')}</span><strong><bdi>{formatMoney(split.paid, split.currency)}</bdi></strong></div>
          <div><span>{t('progress.remaining')}</span><strong><bdi>{formatMoney(split.outstanding, split.currency)}</bdi></strong></div>
        </div>
        <div
          className="sp__bar"
          role="progressbar"
          aria-valuenow={split.percent_paid}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('progress.progressLabel')}
        >
          <span style={{ width: `${Math.min(100, Math.max(0, split.percent_paid))}%` }} />
        </div>

        {open && countdown && (
          <p className="sp__clock"><Clock /> {t('progress.within', { time: countdown })}</p>
        )}
        {split.status === 'expired' && (
          <p className="sp__notice">{t('progress.expiredNotice')}</p>
        )}
        {split.status === 'cancelled' && (
          <p className="sp__notice">{t('progress.cancelledNotice')}</p>
        )}

        <ul className="sp__people">
          {split.shares.map((share) => {
            const tone = shareTone(share.status);
            const url = links[String(share.id)];
            return (
              <li key={share.id} className="sp__person">
                <div className="sp__person-who">
                  <strong>{share.is_organizer ? t('split.you') : share.name}</strong>
                  <span><bdi>{formatMoney(share.amount, split.currency)}</bdi></span>
                </div>
                <span className={`sp__state ${tone.className}`}>{t(tone.labelKey)}</span>
                <div className="sp__person-acts">
                  {share.payable && url && (
                    <>
                      <button type="button" onClick={async () => {
                        const outcome = await copyLink(url);
                        if (outcome === 'copied') {
                          setCopied(String(share.id));
                          setTimeout(() => setCopied(''), 2000);
                        }
                      }}>{t(copied === String(share.id) ? 'handoff.copied' : 'handoff.copyLink')}</button>
                      <button type="button" onClick={() => shareLink(url,
                        t('handoff.shareMessage', {
                          name: share.name || '',
                          amount: formatMoney(share.amount, split.currency),
                        }))}>{t('handoff.share')}</button>
                    </>
                  )}
                  {share.payable && !url && (
                    <button type="button" disabled={busy === 'reissue_link'}
                      onClick={async () => {
                        const data = await act(
                          { action: 'reissue_link', share: share.id },
                          { after: (result) => rememberLink(share.id, result.link) });
                        if (data?.link) rememberLink(share.id, data.link);
                      }}>{t('progress.newLink')}</button>
                  )}
                  {share.payable && !share.is_organizer && (
                    <button type="button" className="sp__danger"
                      disabled={busy === 'cancel_share'}
                      onClick={() => act({ action: 'cancel_share', share: share.id })}>
                      {t('progress.cancelShare')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {error && <p className="sp__error" role="alert">{error}</p>}

        {open && outstanding > 0 && (
          <div className="sp__remaining">
            {payingRemaining ? (
              <>
                <h2 className="sp__sub">{t('progress.payRemainingTitle')}</h2>
                <CardForm card={card} setCard={setCard}
                  config={{ demo_mode: false }} disabled={busy === 'pay_remaining'} />
                <button type="button" className="sp__pay"
                  disabled={busy === 'pay_remaining'}
                  onClick={() => act({ action: 'pay_remaining', card: cardRequest(card) })}>
                  {busy === 'pay_remaining' ? t('pay.paying')
                    : t('pay.payAmount',
                      { amount: formatMoney(split.outstanding, split.currency) })}
                </button>
                <button type="button" className="sp__link"
                  onClick={() => setPayingRemaining(false)}>{t('progress.cancel')}</button>
              </>
            ) : (
              <button type="button" className="sp__pay"
                onClick={() => setPayingRemaining(true)}>
                {t('progress.payRemaining',
                  { amount: formatMoney(split.outstanding, split.currency) })}
              </button>
            )}
          </div>
        )}

        {open && (
          <button type="button" className="sp__link sp__danger"
            disabled={busy === 'cancel'}
            onClick={() => {
              if (window.confirm(t('progress.cancelConfirm'))) {
                act({ action: 'cancel' });
              }
            }}>{t('progress.cancelSplit')}</button>
        )}
      </div>
    </div>
  );
}


// --------------------------------------------------------------------------- //
// Island entry points
// --------------------------------------------------------------------------- //
/**
 * Astro mounts each island as its own React root, so each one provides i18n for
 * itself. `locale` comes from the server render: an island that worked the
 * language out on the client would show a flash of English first.
 */
export function SharePay({ token, locale }) {
  return <I18n locale={locale}><SharePayBody token={token} /></I18n>;
}

export function SplitProgress({ token, locale }) {
  return <I18n locale={locale}><SplitProgressBody token={token} /></I18n>;
}
