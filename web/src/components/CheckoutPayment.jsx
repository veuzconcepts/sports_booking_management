import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Checkout payment: method tiles, card form and the split configuration.
 *
 * Everything here is presentation and input capture. It previews an equal split
 * so the customer can see "SAR 9.80 each" before committing, but that preview is
 * never what gets charged: the backend recomputes the allocation from the
 * booking's own outstanding balance, so a tampered browser changes nothing.
 * Card details live in component state for the length of one submit and are
 * never written to storage.
 */

// --------------------------------------------------------------------------- //
// Icons
// --------------------------------------------------------------------------- //
export const CardIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M2 10h20" />
  </svg>
);

export const WalletIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="6" y="2" width="12" height="20" rx="2.6" /><path d="M11 18.5h2" />
  </svg>
);

export const VenueIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M3 21h18M4 21V9l8-5 8 5v12" /><path d="M9 21v-6h6v6" />
  </svg>
);

export const SplitIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
    <circle cx="17.5" cy="9.5" r="2.4" />
    <path d="M15.6 14.4c2.6.3 4.4 2.2 4.4 4.6" />
  </svg>
);

export const LockIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2.2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

export const ClockIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);

export const CheckIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M4 12.5l5.5 5.5L20 7" />
  </svg>
);

// --------------------------------------------------------------------------- //
// Money helpers
// --------------------------------------------------------------------------- //
/** Minor units in the amount, as an integer, so splitting never uses floats. */
function toUnits(amount) {
  const cents = Math.round(Number(amount || 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

function fromUnits(units) {
  return (units / 100).toFixed(2);
}

/**
 * The same largest-remainder allocation the backend performs, for preview only.
 *
 * Kept identical on purpose: if the preview said 9.80 each and the server then
 * charged somebody 9.81 without warning, the customer would be right to feel
 * misled. The server still has the final word.
 */
export function previewEqualSplit(total, people) {
  const count = Math.max(1, Number(people) || 1);
  const units = toUnits(total);
  if (units < count) return [];
  const base = Math.floor(units / count);
  const extra = units - base * count;
  return Array.from({ length: count },
    (_, index) => fromUnits(base + (index >= count - extra ? 1 : 0)));
}

export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '';
  const value = Number(amount);
  const text = Number.isFinite(value)
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
  return currency ? `${currency} ${text}` : text;
}

// --------------------------------------------------------------------------- //
// Sharing
// --------------------------------------------------------------------------- //
/**
 * Copy a link, preferring the native share sheet on the phones this feature is
 * actually used on. Falls back through the clipboard API to a hidden textarea,
 * because the clipboard API needs a secure context that a LAN test server on
 * plain http will not have.
 */
export async function shareLink(url, text) {
  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return 'shared';
    } catch {
      return 'cancelled';           // the user dismissed the sheet
    }
  }
  return copyLink(url);
}

export async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    try {
      const holder = document.createElement('textarea');
      holder.value = url;
      holder.setAttribute('readonly', '');
      holder.style.position = 'absolute';
      holder.style.left = '-9999px';
      document.body.appendChild(holder);
      holder.select();
      document.execCommand('copy');
      document.body.removeChild(holder);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}

// --------------------------------------------------------------------------- //
// Method tiles
// --------------------------------------------------------------------------- //
/**
 * Which methods exist is the BACKEND's answer, not this component's.
 *
 * `card` appears only when a provider is actually configured, and `venue` only
 * where the club accepts payment at the desk. Both answers come from the same
 * payload the server enforces against, so a tile that is shown can always be
 * used. A wallet tile (Apple Pay and similar) is listed here for the day a
 * provider supports one and is filtered out until then, rather than rendered as
 * a button that does nothing.
 */
export function paymentTiles({ config, country, splitOn }) {
  // mada is Saudi Arabia's domestic card network, so the label only claims it
  // where it actually applies.
  const cardKey = String(country || '').toUpperCase() === 'SA'
    ? 'methods.cardMada' : 'methods.card';
  const tiles = [
    { key: 'card', labelKey: cardKey, icon: <CardIcon />,
      available: Boolean(config?.card_enabled) },
    { key: 'wallet', labelKey: 'methods.wallet', icon: <WalletIcon />,
      available: Boolean(config?.wallet_enabled) },
    // Two separate reasons this tile can be withdrawn. The club may simply not
    // take money at the desk, which the backend reports as `cash_enabled`; and
    // paying on arrival cannot be split between payment links, so it also goes
    // while a split is being arranged rather than being chosen and then
    // refused. `cash_enabled` missing from an older payload is read as true, so
    // a checkout that has not been told otherwise keeps working.
    { key: 'venue', labelKey: 'methods.venue', icon: <VenueIcon />,
      available: config?.cash_enabled !== false && !splitOn },
  ];
  return tiles.filter((tile) => tile.available);
}

export function PaymentMethods({ method, onPick, config, country, splitOn, heading }) {
  const { t } = useTranslation();
  const tiles = paymentTiles({ config, country, splitOn });
  const labelId = 'pay-method-label';
  if (tiles.length === 0) {
    return <p className="ck__none" role="status">{t('methods.unavailable')}</p>;
  }
  return (
    <div className="ck__methods">
      {heading && <span className="ck__label" id={labelId}>{heading}</span>}
      <div className="ck__tiles" role="group" aria-labelledby={heading ? labelId : undefined}>
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            aria-pressed={method === tile.key}
            className={`ck__tile${method === tile.key ? ' is-on' : ''}`}
            onClick={() => onPick(tile.key)}
          >
            <span className="ck__tile-ic">{tile.icon}</span>
            <span className="ck__tile-tx">{t(tile.labelKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Card form
// --------------------------------------------------------------------------- //
const BLANK_CARD = { holder: '', number: '', expiry: '', cvv: '' };

export function blankCard() {
  return { ...BLANK_CARD };
}

/** Group the digits the way a card is printed, so long numbers stay readable. */
function groupCardNumber(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiry(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

/**
 * `compact` drops the cardholder field, for the split panel where the payer is
 * already named above it and a fourth field would only add friction.
 */
export function CardForm({ card, setCard, config, disabled, compact = false }) {
  const { t } = useTranslation();
  const set = (field) => (event) => {
    const raw = event.target.value;
    const value = field === 'number' ? groupCardNumber(raw)
      : field === 'expiry' ? formatExpiry(raw)
        : field === 'cvv' ? raw.replace(/\D/g, '').slice(0, 4)
          : raw;
    setCard((current) => ({ ...current, [field]: value }));
  };

  const demo = Boolean(config?.demo_mode);
  const [scenario, setScenario] = useState('');

  const useTestCard = (number) => {
    if (!number) return;
    setCard({
      holder: 'Test Player',
      number: groupCardNumber(number),
      expiry: config?.test_expiry || '12/30',
      cvv: config?.test_cvv || '123',
    });
  };

  return (
    <div className="ck__card">
      {demo && (
        <div className="ck__demo">
          <div className="ck__demo-top">
            <span className="ck__demo-tag">{t('demo.tag')}</span>
            <button type="button" className="ck__demo-btn" disabled={disabled}
              onClick={() => useTestCard(config.test_cards?.[0]?.number)}>
              {t('demo.use')}
            </button>
          </div>
          <p>{t('demo.note')}</p>
          <label className="ck__demo-pick">
            <span className="ck__sr">{t('demo.scenario')}</span>
            <select value={scenario} disabled={disabled}
              onChange={(event) => {
                setScenario(event.target.value);
                useTestCard(event.target.value);
              }}>
              <option value="">{t('demo.otherScenarios')}</option>
              {(config.test_cards || []).map((entry) => (
                <option key={entry.number} value={entry.number}>{entry.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className={`ck__fields${compact ? ' ck__fields--compact' : ''}`}>
        {!compact && (
          <div className="ck__field ck__field--name">
            <label htmlFor="pay-holder">{t('card.holder')}</label>
            <input id="pay-holder" className="ck__input" autoComplete="cc-name"
              value={card.holder} onChange={set('holder')} disabled={disabled}
              placeholder={t('card.holderPlaceholder')} />
          </div>
        )}
        <div className="ck__field ck__field--number">
          <label htmlFor="pay-number">{t('card.number')}</label>
          <input id="pay-number" className="ck__input" inputMode="numeric"
            autoComplete="cc-number" value={card.number} onChange={set('number')}
            disabled={disabled} placeholder={t('card.numberPlaceholder')} />
        </div>
        <div className="ck__field">
          <label htmlFor="pay-expiry">{t('card.expiry')}</label>
          <input id="pay-expiry" className="ck__input" inputMode="numeric"
            autoComplete="cc-exp" value={card.expiry} onChange={set('expiry')}
            disabled={disabled} placeholder={t('card.expiryPlaceholder')} />
        </div>
        <div className="ck__field">
          <label htmlFor="pay-cvv">{t('card.cvv')}</label>
          {/* type=password so a shoulder-surfer or a screen recording cannot
              read the security code straight off the page. */}
          <input id="pay-cvv" className="ck__input" type="password"
            inputMode="numeric" autoComplete="cc-csc" value={card.cvv}
            onChange={set('cvv')} disabled={disabled} placeholder={t('card.cvvPlaceholder')} />
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Split
// --------------------------------------------------------------------------- //
export function blankSplit() {
  return {
    on: false,
    mode: 'equal',
    people: 3,
    payMyShareNow: true,
    friends: [{ name: '', contact: '' }, { name: '', contact: '' }],
    custom: [],
  };
}

/** Initials for the organizer's avatar, so "You" still has an identity. */
function initialsOf(name) {
  return String(name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0].toUpperCase()).join('') || 'ME';
}

/** The row that offers the split, shown whether or not it is switched on. */
export function SplitToggle({ on, onChange, disabled }) {
  const { t } = useTranslation();
  return (
    <div className={`ck__splitrow${on ? ' is-on' : ''}`}>
      <span className="ck__splitrow-ic"><SplitIcon /></span>
      <div className="ck__splitrow-tx">
        <strong>{t('split.title')}</strong>
        <span>{t('split.subtitle')}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t('split.title')}
        className="ck__switch"
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="ck__switch-dot" />
      </button>
    </div>
  );
}

export function SplitPanel({ split, setSplit, total, currency, disabled,
  organizerName, holdMinutes }) {
  const { t } = useTranslation();
  const update = (patch) => setSplit((current) => ({ ...current, ...patch }));

  // Which rows have their contact box open. Contact details are optional by
  // design (an organizer may just want a link to paste into a group chat), so
  // the field stays out of the way until it is asked for, and reopens by itself
  // for any row that already has one.
  const [contactsOpen, setContactsOpen] = useState(() => new Set());
  const openContact = (index) => setContactsOpen((current) => {
    const next = new Set(current);
    next.add(index);
    return next;
  });

  const preview = useMemo(
    () => previewEqualSplit(total, split.people), [total, split.people]);

  // Keep the friend rows in step with the headcount, so the organizer never
  // fills in a name for somebody the split no longer has room for.
  useEffect(() => {
    setSplit((current) => {
      const wanted = Math.max(0, (Number(current.people) || 1) - 1);
      if (current.friends.length === wanted) return current;
      const friends = current.friends.slice(0, wanted);
      while (friends.length < wanted) friends.push({ name: '', contact: '' });
      return { ...current, friends };
    });
  }, [split.people, setSplit]);

  // Custom mode starts from whatever equal mode was showing, so the organizer
  // adjusts real numbers instead of typing everything from nothing.
  useEffect(() => {
    if (split.mode !== 'custom' || split.custom.length) return;
    setSplit((current) => ({
      ...current,
      custom: previewEqualSplit(total, current.people).map((amount, index) => ({
        name: index === 0 ? '' : (current.friends[index - 1]?.name || ''),
        contact: index === 0 ? '' : (current.friends[index - 1]?.contact || ''),
        amount,
        isOrganizer: index === 0,
      })),
    }));
  }, [split.mode, split.custom.length, split.people, split.friends, total, setSplit]);

  const setFriend = (index, field) => (event) => {
    const value = event.target.value;
    setSplit((current) => ({
      ...current,
      friends: current.friends.map((friend, i) =>
        (i === index ? { ...friend, [field]: value } : friend)),
    }));
  };

  const setCustom = (index, field) => (event) => {
    const value = event.target.value;
    setSplit((current) => ({
      ...current,
      custom: current.custom.map((row, i) =>
        (i === index ? { ...row, [field]: value } : row)),
    }));
  };

  const addCustomRow = () => setSplit((current) => ({
    ...current,
    custom: [...current.custom, { name: '', contact: '', amount: '', isOrganizer: false }],
  }));

  const removeCustomRow = (index) => setSplit((current) => ({
    ...current,
    custom: current.custom.filter((_, i) => i !== index),
  }));

  const customUnits = split.custom.reduce((sum, row) => sum + toUnits(row.amount), 0);
  const difference = customUnits - toUnits(total);

  const rows = split.mode === 'custom'
    ? split.custom
    : preview.map((amount, index) => ({
      amount,
      isOrganizer: index === 0,
      name: index === 0 ? '' : (split.friends[index - 1]?.name || ''),
      contact: index === 0 ? '' : (split.friends[index - 1]?.contact || ''),
    }));

  return (
    <div className="ck__split">
      <div className="ck__split-head">
        <span className="ck__splitrow-ic"><SplitIcon /></span>
        <div className="ck__splitrow-tx">
          <strong>{t('split.title')}</strong>
          <span>{t('split.subtitle')}</span>
        </div>
        <button type="button" role="switch" aria-checked="true"
          aria-label={t('split.title')} className="ck__switch is-on"
          disabled={disabled} onClick={() => update({ on: false })}>
          <span className="ck__switch-dot" />
        </button>
      </div>

      <div className="ck__split-controls">
        <div className="ck__players">
          <span id="players-label">{t('split.players')}</span>
          <div className="ck__stepper">
            <button type="button" aria-label={t('split.fewerPlayers')} disabled={disabled}
              onClick={() => update({ people: Math.max(2, (Number(split.people) || 2) - 1) })}>
              <span aria-hidden="true">-</span>
            </button>
            <input inputMode="numeric" value={split.people} disabled={disabled}
              aria-labelledby="players-label"
              onChange={(event) => {
                const next = Number(String(event.target.value).replace(/\D/g, ''));
                update({ people: Math.min(20, Math.max(2, next || 2)) });
              }} />
            <button type="button" aria-label={t('split.morePlayers')} disabled={disabled}
              onClick={() => update({ people: Math.min(20, (Number(split.people) || 2) + 1) })}>
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
        <div className="ck__seg" role="group" aria-label={t('split.howToDivide')}>
          <button type="button" disabled={disabled} aria-pressed={split.mode === 'equal'}
            className={`ck__seg-b${split.mode === 'equal' ? ' is-on' : ''}`}
            onClick={() => update({ mode: 'equal' })}>{t('split.equal')}</button>
          <button type="button" disabled={disabled} aria-pressed={split.mode === 'custom'}
            className={`ck__seg-b${split.mode === 'custom' ? ' is-on' : ''}`}
            onClick={() => update({ mode: 'custom' })}>{t('split.custom')}</button>
        </div>
      </div>

      {split.mode === 'equal' && preview.length === 0 && (
        <p className="ck__split-warn" role="alert">{t('split.tooManyPlayers')}</p>
      )}

      <ul className="ck__people">
        {rows.map((row, index) => (
          <li className="ck__person" key={index}>
            <span className={`ck__avatar${row.isOrganizer ? ' is-me' : ''}`} aria-hidden="true">
              {row.isOrganizer ? initialsOf(organizerName) : index + 1}
            </span>
            <div className="ck__person-tx">
              {row.isOrganizer ? (
                <>
                  <strong>{t('split.you')}</strong>
                  <span>
                    {t(split.payMyShareNow ? 'split.payingNow' : 'split.payingLater')}
                  </span>
                </>
              ) : (
                <>
                  {/* An inline input rather than a separate form: the organizer
                      may name a friend or leave it blank for a link they hand
                      over themselves, and neither should feel like extra work. */}
                  <input
                    className="ck__person-name"
                    value={row.name}
                    disabled={disabled}
                    placeholder={t('split.friendPlaceholder', { number: index + 1 })}
                    aria-label={t('split.nameFor', { number: index + 1 })}
                    onChange={split.mode === 'custom'
                      ? setCustom(index, 'name') : setFriend(index - 1, 'name')}
                  />
                  {contactsOpen.has(index) || row.contact ? (
                    <input
                      className="ck__person-contact"
                      value={row.contact || ''}
                      disabled={disabled}
                      placeholder={t('split.contactPlaceholder')}
                      aria-label={t('split.contactFor', { number: index + 1 })}
                      onChange={split.mode === 'custom'
                        ? setCustom(index, 'contact') : setFriend(index - 1, 'contact')}
                    />
                  ) : (
                    <span className="ck__person-sub">
                      {t('split.getsLink')}
                      <button type="button" className="ck__person-add" disabled={disabled}
                        onClick={() => openContact(index)}>
                        {t('split.addContact')}
                      </button>
                    </span>
                  )}
                </>
              )}
            </div>
            {split.mode === 'custom' ? (
              <span className="ck__person-amt">
                <input className="ck__amt-in" inputMode="decimal" value={row.amount}
                  disabled={disabled} placeholder="0.00"
                  aria-label={t('split.amountFor', { number: index + 1 })}
                  onChange={setCustom(index, 'amount')} />
                {!row.isOrganizer && (
                  <button type="button" className="ck__person-x" disabled={disabled}
                    aria-label={t('split.removePlayer', { number: index + 1 })}
                    onClick={() => removeCustomRow(index)}>✕</button>
                )}
              </span>
            ) : (
              <strong className="ck__person-amt">{formatMoney(row.amount, currency)}</strong>
            )}
          </li>
        ))}
      </ul>

      {split.mode === 'custom' && (
        <>
          <button type="button" className="ck__addrow" onClick={addCustomRow}
            disabled={disabled}>+ {t('split.addPlayer')}</button>
          <div className={`ck__alloc${difference === 0 ? ' is-ok' : ' is-off'}`}>
            <span>{t('split.allocated')}</span>
            <strong>{formatMoney(fromUnits(customUnits), currency)}</strong>
            {difference !== 0 && (
              <em>
                {t(difference > 0 ? 'split.over' : 'split.leftToAllocate',
                  { amount: formatMoney(fromUnits(Math.abs(difference)), currency) })}
              </em>
            )}
          </div>
        </>
      )}

      <label className="ck__check">
        <input type="checkbox" checked={split.payMyShareNow} disabled={disabled}
          onChange={(event) => update({ payMyShareNow: event.target.checked })} />
        <span>{t('split.payMyShareNow')}</span>
      </label>

      <p className="ck__split-note">
        <ClockIcon />
        <span>{t('split.note', { minutes: holdMinutes })}</span>
      </p>
    </div>
  );
}

/** The split section of a checkout submission, shaped for the backend. */
export function splitRequest(split) {
  if (split.mode === 'custom') {
    return {
      mode: 'custom',
      pay_my_share_now: Boolean(split.payMyShareNow),
      participants: split.custom.map((row) => ({
        name: row.name,
        amount: row.amount,
        is_organizer: Boolean(row.isOrganizer),
        ...contactFields(row.contact),
      })),
    };
  }
  return {
    mode: 'equal',
    people: Number(split.people) || 2,
    include_me: true,
    pay_my_share_now: Boolean(split.payMyShareNow),
    friends: split.friends.map((friend) => ({
      name: friend.name, ...contactFields(friend.contact),
    })),
  };
}

/**
 * One contact box accepts either an email or a phone number.
 *
 * Demanding both for a link the organizer is going to paste into a group chat
 * would be collecting somebody else's details for no reason.
 */
function contactFields(value) {
  const contact = String(value || '').trim();
  if (!contact) return { email: '', phone: '' };
  return contact.includes('@') ? { email: contact, phone: '' }
    : { email: '', phone: contact };
}

/** The card section of a submission. Sent once, kept nowhere. */
export function cardRequest(card) {
  return {
    holder: card.holder,
    number: String(card.number || '').replace(/\s/g, ''),
    expiry: card.expiry,
    cvv: card.cvv,
  };
}

/** A participant's state, as a class and a label. */
export function shareTone(status) {
  const known = ['paid', 'failed', 'expired', 'cancelled'];
  const state = known.includes(status) ? status : 'pending';
  return { className: `is-${state}`, labelKey: `states.${state}` };
}

/** A live countdown to a deadline, as `MM:SS`, or '' once it has passed. */
export function useCountdown(expiresAt) {
  const [remaining, setRemaining] = useState(() => msUntil(expiresAt));
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setInterval(() => setRemaining(msUntil(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt || remaining <= 0) return '';
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function msUntil(when) {
  if (!when) return 0;
  const target = new Date(when).getTime();
  return Number.isFinite(target) ? target - Date.now() : 0;
}
