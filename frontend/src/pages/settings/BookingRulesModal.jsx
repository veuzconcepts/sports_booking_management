import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { bookingPoliciesApi } from '../../services/bookingsService.js';
import { apiErrorMessage } from '../../utils/apiError.js';

import './bookingRules.css';

/**
 * How many time slots one booking may hold, at any level of the chain: every
 * club, one club, or a single facility.
 *
 * Every field can be left empty, which means "inherit". That is the whole
 * point of the screen: a court that wants to cap itself at two slots should
 * not have to restate its club's lead time and cancellation window to do it.
 * An empty field shows the inherited value as its placeholder, so the operator
 * can always see what leaving it alone will actually do.
 *
 * The rules themselves are resolved by the backend. This screen never computes
 * an effective value; it asks for one.
 */
const FIELDS = ['allow_multiple_slots', 'allow_multiple_dates',
  'require_consecutive_slots', 'min_slots_per_booking', 'max_slots_per_booking'];

export function BookingRulesModal({ scope, onClose, onSaved }) {
  const { t } = useTranslation('settings');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [inherited, setInherited] = useState(null);
  const [policyId, setPolicyId] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [overrides, setOverrides] = useState(null);
  const [confirmApply, setConfirmApply] = useState(false);
  // Bumped by Retry. A failed load used to leave the panel on "Loading" for
  // ever, because the catch cleared the flag but never filled the form, so an
  // unapplied migration or a dropped request looked exactly like a slow one.
  const [attempt, setAttempt] = useState(0);

  const open = Boolean(scope);
  const label = scope?.facility?.name || scope?.club?.name
    || (scope?.organization ? t('allClubs') : '');
  // Depend on the IDs, not on `scope` itself. The parent builds that object
  // inline, so it is a new reference on every render, and an effect keyed on
  // it would refetch, setState and re-render forever. `t` is left out for the
  // same reason: it is only used in the catch, and a test double that returns
  // a fresh function each render would restart the loop.
  const facilityId = scope?.facility?.id ?? null;
  const clubId = scope?.club?.id ?? null;
  // "Every club" is a scope in its own right, not the absence of one: it is
  // the organization default row, and it is where a rule is set once for
  // everywhere rather than club by club.
  const orgScope = Boolean(scope?.organization);

  useEffect(() => {
    if (!facilityId && !clubId && !orgScope) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    let params = {};
    if (facilityId) params = { facility: facilityId };
    else if (clubId) params = { club: clubId };
    bookingPoliciesApi.effective(params)
      .then((data) => {
        if (cancelled) return;
        setInherited(data.rules);
        setOverrides(data.overrides || null);
        setPolicyId(data.policy?.id || null);
        // Only this row's own values go in the form. Anything it does not
        // state stays empty so it keeps inheriting.
        const own = data.policy || {};
        setForm(Object.fromEntries(FIELDS.map((key) => [
          key, own[key] === undefined ? null : own[key],
        ])));
        setLoading(false);
      })
      .catch((failure) => {
        if (cancelled) return;
        const message = apiErrorMessage(failure, t('couldNotLoadBookingRules'));
        setError(message);
        toast.error(message);
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId, clubId, orgScope, attempt]);

  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

  const number = (key) => (event) => {
    const raw = event.target.value.trim();
    set(key)(raw === '' ? null : Math.max(1, Number(raw.replace(/\D/g, '')) || 1));
  };

  /** A tri-state control: inherit, on, or off. */
  const TriState = ({ field, title, hint }) => (
    <div className="br__row">
      <div className="br__row-tx">
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </div>
      <div className="br__tri" role="group" aria-label={title}>
        {[
          { value: null, label: t('inherit') },
          { value: true, label: t('common:state.yes') },
          { value: false, label: t('common:state.no') },
        ].map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={form[field] === option.value}
            className={`br__tri-b${form[field] === option.value ? ' is-on' : ''}`}
            onClick={() => set(field)(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {form[field] === null && inherited && (
        <span className="br__inherited">
          {t('currently')} {inherited[field] ? t('common:state.yes') : t('common:state.no')}
        </span>
      )}
    </div>
  );

  async function save() {
    setBusy(true);
    try {
      const payload = { ...form };
      if (policyId) {
        await bookingPoliciesApi.update(policyId, payload);
      } else {
        // A row is only created once something is actually overridden. The
        // organization scope always has one already, so it never lands here.
        await bookingPoliciesApi.create({
          ...payload,
          ...(facilityId ? { facility: facilityId } : { club: clubId }),
        });
      }
      toast.success(t('bookingRulesSaved'));
      onSaved?.();
      onClose();
    } catch (error) {
      toast.error(apiErrorMessage(error, t('couldNotSaveBookingRules')));
    } finally {
      setBusy(false);
    }
  }

  async function resetToInherited() {
    if (!policyId) { onClose(); return; }
    setBusy(true);
    try {
      await bookingPoliciesApi.remove(policyId);
      toast.success(t('bookingRulesReset'));
      onSaved?.();
      onClose();
    } catch (error) {
      toast.error(apiErrorMessage(error, t('couldNotSaveBookingRules')));
    } finally {
      setBusy(false);
    }
  }

  /** Make every club or facility below this scope follow it again. */
  async function applyToEverythingBelow() {
    setBusy(true);
    try {
      await bookingPoliciesApi.clearOverrides(clubId || undefined);
      setConfirmApply(false);
      setOverrides({ clubs: 0, facilities: 0 });
      toast.success(t('slotOverridesCleared'));
      onSaved?.();
    } catch (failure) {
      setConfirmApply(false);
      toast.error(apiErrorMessage(failure, t('couldNotClearOverrides')));
    } finally {
      setBusy(false);
    }
  }

  // Nothing is more specific than a facility, so there is nothing below one.
  const overrideTotal = facilityId || !overrides
    ? 0 : (overrides.clubs || 0) + (overrides.facilities || 0);

  const multiOn = form?.allow_multiple_slots === true
    || (form?.allow_multiple_slots === null && inherited?.allow_multiple_slots);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={label ? `${t('bookingRules')} · ${label}` : t('bookingRules')}
      size="md"
      footer={(
        <div className="br__foot">
          {policyId && (
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={resetToInherited}>{t('resetToInherited')}</button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || loading || !form}
            onClick={save}>{t('common:actions.save')}</button>
        </div>
      )}
    >
      {loading ? (
        <p className="muted">{t('common:state.loading')}</p>
      ) : error || !form ? (
        <div className="br__error" role="alert">
          <p>{error || t('couldNotLoadBookingRules')}</p>
          <button type="button" className="btn btn-secondary"
            onClick={() => setAttempt((n) => n + 1)}>
            {t('common:actions.retry')}
          </button>
        </div>
      ) : (
        <>
          <p className="muted br__intro">{t('bookingRulesIntro')}</p>

          <TriState
            field="allow_multiple_slots"
            title={t('allowMultipleSlots')}
            hint={t('allowMultipleSlotsHint')}
          />

          {/* The rest only matter once several slots are allowed, so they are
              not shown competing for attention until then. */}
          {multiOn && (
            <>
              <TriState
                field="allow_multiple_dates"
                title={t('allowMultipleDates')}
                hint={t('allowMultipleDatesHint')}
              />
              <TriState
                field="require_consecutive_slots"
                title={t('requireConsecutive')}
                hint={t('requireConsecutiveHint')}
              />
              <div className="br__pair">
                <FormField label={t('minSlots')} hint={t('emptyInherits')}>
                  <input className="form-input" inputMode="numeric"
                    value={form.min_slots_per_booking ?? ''}
                    placeholder={String(inherited?.min_slots_per_booking ?? 1)}
                    onChange={number('min_slots_per_booking')} />
                </FormField>
                <FormField label={t('maxSlots')} hint={t('emptyInherits')}>
                  <input className="form-input" inputMode="numeric"
                    value={form.max_slots_per_booking ?? ''}
                    placeholder={String(inherited?.max_slots_per_booking ?? 1)}
                    onChange={number('max_slots_per_booking')} />
                </FormField>
              </div>
            </>
          )}

          {inherited && (
            <p className="br__effective">
              {t('inEffectHere')}{' '}
              <strong>
                {inherited.allow_multiple_slots
                  ? t('upToNSlots', { count: inherited.max_slots_per_booking })
                  : t('oneSlotOnly')}
              </strong>
              {inherited.allow_multiple_slots && inherited.allow_multiple_dates
                ? `, ${t('acrossDates')}` : ''}
              {inherited.allow_multiple_slots && inherited.require_consecutive_slots
                ? `, ${t('backToBack')}` : ''}
            </p>
          )}

          {/* A change made here stops at anything below that states a rule of
              its own, so the panel names them rather than letting the operator
              wonder why one court did not follow. */}
          {!facilityId && overrides && (
            <div className="br__below">
              {overrideTotal === 0 ? (
                <p className="muted">{t('nothingOverridesBelow')}</p>
              ) : (
                <>
                  <strong>{t('overridesBelow')}</strong>
                  <p className="muted">{t('overridesBelowHint')}</p>
                  <ul className="br__below-list">
                    {overrides.clubs > 0 && (
                      <li>{t('clubsWithOwnRules')}: {overrides.clubs}</li>
                    )}
                    {overrides.facilities > 0 && (
                      <li>{t('facilitiesWithOwnRules')}: {overrides.facilities}</li>
                    )}
                  </ul>
                  <button type="button" className="btn btn-secondary" disabled={busy}
                    onClick={() => setConfirmApply(true)}>
                    {t('applyToEverythingBelow')}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmApply}
        tone="danger"
        title={t('applyToEverythingBelow')}
        confirmLabel={t('common:actions.apply')}
        message={t('applyToEverythingBelowHint')}
        onConfirm={applyToEverythingBelow}
        onClose={() => setConfirmApply(false)}
      />
    </Modal>
  );
}

export default BookingRulesModal;
