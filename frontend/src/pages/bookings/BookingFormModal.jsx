import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { PhoneField, isMobileValid } from '../../components/PhoneField.jsx';
import { DateCalendar } from '../../components/DateCalendar.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useBookingConfig } from '../../hooks/useBookingConfig.js';
import { formatMoney } from '../../services/currency.jsx';

import {
  recurrenceRules,
  bookingPriorities,
  paymentStatuses,
  paymentMethods,
  bookingsApi,
  bookingWindowApi,
} from '../../services/bookingsService.js';
import { customersApi } from '../../services/customersService.js';
import { facilityCategoriesApi, facilityTypesApi, addonsApi } from '../../services/facilitiesService.js';
import { clubsApi } from '../../services/clubsService.js';
import { organizationApi } from '../../services/settingsService.js';
import { usersApi } from '../../services/usersService.js';
import { PriceSummary } from './PriceSummary.jsx';
import { MembershipCoverageSummary } from './MembershipCoverageSummary.jsx';
import { CustomerFormModal } from '../customers/CustomerFormModal.jsx';
import { formatTime } from '../../services/timeformat.jsx';
import { apiErrorMessage } from '../../utils/apiError';

const DAY_KEY_BY_GETDAY = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
// Weekday indices (JS getDay 0-6) closed for a given schedule object.
const closedWeekdaySet = (hours) => {
  const s = new Set();
  for (let gd = 0; gd < 7; gd += 1) {
    const cfg = hours?.[DAY_KEY_BY_GETDAY[gd]];
    if (cfg && cfg.closed) s.add(gd);
  }
  return s;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * What to say about a slot's capacity.
 *
 * "Full" and "somebody is part way through paying for it" are different
 * facts, and staff need to tell them apart: one is gone for the day, the
 * other is very likely free again in a few minutes. The customer website
 * withdraws a held slot instead, because a customer only needs to pick
 * something else; a receptionist with a person at the desk needs to know
 * whether it is worth waiting.
 *
 * `held` counts courts a live reservation is holding. A payload without it
 * (an older backend) reads exactly as it always did.
 */
export function slotState(slot) {
  if (slot.available > 0) return `${slot.available} free`;
  return slot.held > 0 ? 'being booked' : 'full';
}

const makeDefaults = () => ({
  scheduled_date: todayISO(),
  recurrence: 'none',
  priority: 'normal',
  payment_status: 'pending',
  booking_type: 'advance',
  add_ons: [],
});

// `initial` (optional) prefills the form. With `editId` it edits that booking
// in place (PATCH); otherwise a non-null `initial` is a DUPLICATE (same inputs,
// fresh date/time, no history/invoices/payments carried over).
export function BookingFormModal({ open, onClose, onSaved, initial = null, editId = null,
                                   lockedExceptNotes = false }) {
  const { t } = useTranslation('bookings');
  const isEdit = Boolean(editId);
  const { hasPerm } = useAuth();
  const {
    register, handleSubmit, watch, reset, setValue, control, getValues,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: makeDefaults() });

  // Editing something the admin already parked. The lifecycle is the same as
  // a new booking's; what differs is that "finish" is now a real step.
  const editingDraft = isEdit && initial?.status === 'draft';
  // Drafts are for taking a booking, not for revisiting one, so the option
  // only appears where it means something.
  const canDraft = (!isEdit || editingDraft) && hasPerm(isEdit ? 'bookings.edit' : 'bookings.add');

  const customerId = watch('customer');
  const scheduledDate = watch('scheduled_date');
  const categoryId = watch('category');
  const clubId = watch('club');
  const serviceItemId = watch('facility_type');
  const isWalkIn = watch('booking_type') === 'walk_in';
  // Pricing-relevant inputs (drive the live Price Calculation Summary).
  const scheduledTime = watch('scheduled_time');
  const addOnsSel = watch('add_ons');
  const promoInput = watch('promo_code_input');
  const bookingType = watch('booking_type');
  const assignedTo = watch('assigned_to');
  const facilityId = watch('facility');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Promo: the code must be explicitly Applied; only an applied code affects the
  // price. `promoStatus` = { ok, message, discount, currency } | null.
  const [appliedCode, setAppliedCode] = useState('');
  const [promoStatus, setPromoStatus] = useState(null);
  const [promoChecking, setPromoChecking] = useState(false);
  // When the backend rejects on assigned-worker/facility availability (409) and the
  // user may override, hold the reason here and offer an explicit "Save anyway".
  const [conflict, setConflict] = useState(null);

  const customers = useApiList(useCallback((q) => customersApi.list({ ...q, page_size: 100 }), []));
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [pickedCustomer, setPickedCustomer] = useState(null);   // {value,label} pin
  const customerLabel = (c) => `${c.full_name || c.customer_code} · ${c.mobile_number || c.email || '-'}`;

  // Booking Configuration → Walk-in rules (required + duplicate detection).
  const { rulesFor } = useBookingConfig();
  const walkRules = rulesFor('walkin');
  const walkPhone = watch('walk_in_phone');
  const walkEmail = watch('walk_in_email');
  const [walkMatch, setWalkMatch] = useState(null);
  useEffect(() => {
    if (!isWalkIn) { setWalkMatch(null); return undefined; }
    const p = (walkPhone || '').trim();
    const e = (walkEmail || '').trim();
    if (!p && !e) { setWalkMatch(null); return undefined; }
    const t = setTimeout(() => {
      customersApi.lookup({ phone: p, email: e })
        .then((r) => setWalkMatch(r?.match || null)).catch(() => setWalkMatch(null));
    }, 400);
    return () => clearTimeout(t);
  }, [isWalkIn, walkPhone, walkEmail]);

  const useExistingWalkIn = () => {
    if (!walkMatch) return;
    setValue('booking_type', 'advance');
    setValue('customer', walkMatch.id);
    setPickedCustomer({ value: walkMatch.id, label: `${walkMatch.name || walkMatch.code} · ${walkMatch.phone || walkMatch.email || '-'}` });
    setWalkMatch(null);
  };
  const categories = useApiList(useCallback((q) => facilityCategoriesApi.list({ ...q, is_active: 'true', page_size: 100 }), []));
  const services = useApiList(useCallback((q) => facilityTypesApi.list({ ...q, is_active: 'true', page_size: 100 }), []));
  const addons = useApiList(useCallback((q) => addonsApi.list({ ...q, is_active: 'true', page_size: 100 }), []));
  const clubs = useApiList(useCallback((q) => clubsApi.list({ ...q, is_active: 'true' }), []));
  // Staff list follows the selected club (assigned to it, or club-agnostic).
  const staff = useApiList(useCallback(
    (q) => usersApi.list({ ...q, is_active: 'true', page_size: 100, ...(clubId ? { club: clubId } : {}) }),
    [clubId],
  ));
  // Facilities belong to the chosen club (Club serializer nests them). Only
  // units that can host the chosen type are offered; the server allocates one
  // automatically, so this list is purely the staff override.
  const facilityOptions = (clubs.rows.find((s) => s.id === Number(clubId))?.facilities || [])
    .filter((f) => f.is_active)
    .filter((f) => !serviceItemId
      || !(f.facility_types || []).length
      || (f.facility_types || []).includes(Number(serviceItemId)))
    .map((f) => ({ value: f.id, label: f.name }));
  const staffOptions = staff.rows
    .filter((u) => u.role !== 'customer')
    .map((u) => ({ value: u.id, label: `${u.full_name || u.email} (${u.role})` }));
  // Services filtered to the chosen category (ServiceItem.categories holds ids).
  const facilityTypeOptions = services.rows
    .filter((s) => !categoryId || (s.categories || []).includes(Number(categoryId)))
    .map((s) => ({ value: s.id, label: s.name }));
  // Add-ons available for the chosen service (AddOn.services), or unrestricted ones.
  const addonOptions = addons.rows
    .filter((a) => !serviceItemId || !(a.services || []).length || (a.services || []).includes(Number(serviceItemId)))
    .map((a) => ({ value: a.id, label: a.name }));

  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [orgHours, setOrgHours] = useState({});

  // Resolve the effective schedule for the date picker: club override → org.
  const selectedSite = clubs.rows.find((s) => s.id === Number(clubId));
  const effectiveHours = (selectedSite?.booking_hours && Object.keys(selectedSite.booking_hours).length)
    ? selectedSite.booking_hours : orgHours;
  const closedWeekdays = closedWeekdaySet(effectiveHours);

  // Organization default schedule (for the date picker's closed weekdays).
  useEffect(() => {
    if (!open) return;
    organizationApi.get().then((d) => setOrgHours(d.booking_hours || {})).catch(() => {});
  }, [open]);

  // Duplicate: prefill the form from a source booking when the modal opens.
  // Date/time are intentionally blank (the user picks a new slot); history,
  // invoices and payments are never carried over.
  useEffect(() => {
    if (!open || !initial) return;
    const { __customerPin, ...values } = initial;
    // Editing keeps the booking's own schedule; duplicating blanks it.
    reset({ ...makeDefaults(), ...values, ...(isEdit ? {} : { scheduled_date: '', scheduled_time: '' }) });
    setPickedCustomer(__customerPin || null);
    setAppliedCode(''); setPromoStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  // Duplicate prefill sets facility_type but bookings don't store the category
  // (it's a UI filter). Once services load, derive the category from the chosen
  // service so the Category field selects and the Service field enables.
  useEffect(() => {
    if (!serviceItemId || categoryId || !services.rows.length) return;
    const si = services.rows.find((s) => s.id === Number(serviceItemId));
    const cat = (si?.categories || [])[0];
    if (cat) setValue('category', cat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceItemId, categoryId, services.rows]);

  // If switching club makes the chosen date a closed weekday, clear it.
  useEffect(() => {
    if (scheduledDate) {
      const gd = new Date(`${scheduledDate}T00:00:00`).getDay();
      if (closedWeekdays.has(gd)) { setValue('scheduled_date', ''); setValue('scheduled_time', ''); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, orgHours]);

  // The policy window (lead time + horizon) bounds the date picker, so staff see
  // the same limits the server enforces. Staff bookings are usually exempt, so
  // this is guidance here rather than a hard gate - the server has the final say.
  const [window_, setWindow] = useState(null);
  useEffect(() => {
    if (!open) return;
    bookingWindowApi.get(clubId || undefined)
      .then(setWindow)
      .catch(() => setWindow(null));
  }, [open, clubId]);

  // Refresh availability whenever the club, date or facility type changes: the
  // slot list depends on which units can host the type and for how long.
  useEffect(() => {
    if (!open || !scheduledDate) return;
    setSlotsLoading(true);
    bookingsApi.availability(scheduledDate, clubId || undefined, serviceItemId || undefined)
      .then((d) => setSlots(d.slots || []))
      .catch(() => setSlots([]))
      .finally(() => setSlotsLoading(false));
  }, [open, scheduledDate, clubId, serviceItemId]);

  // A stale availability conflict no longer applies once the staff member, facility,
  // date or time changes - clear the banner and drop out of "Save anyway" mode.
  useEffect(() => {
    setConflict(null);
  }, [assignedTo, facilityId, scheduledDate, scheduledTime]);

  // Live, backend-computed price breakdown - recomputes (debounced) whenever any
  // pricing input changes. The backend is the source of truth.
  useEffect(() => {
    if (!open || !serviceItemId) { setPreview(null); return undefined; }
    const payload = {
      facility_type: serviceItemId,
      customer: isWalkIn ? null : customerId,
      club: clubId || null,
      add_ons: addOnsSel || [],
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      booking_type: bookingType,
      promo_code_input: appliedCode,   // only an explicitly-applied code affects price
    };
    setPreviewLoading(true);
    const t = setTimeout(() => {
      bookingsApi.pricePreview(payload)
        .then(setPreview).catch(() => setPreview(null)).finally(() => setPreviewLoading(false));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serviceItemId, customerId, clubId, scheduledDate, scheduledTime,
      bookingType, appliedCode, isWalkIn, (addOnsSel || []).join(',')]);

  // Editing the code after applying clears the applied state (must re-apply).
  useEffect(() => {
    const typed = (promoInput || '').trim().toUpperCase();
    if (appliedCode && typed !== appliedCode) { setAppliedCode(''); setPromoStatus(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoInput]);

  async function applyPromo() {
    const code = (promoInput || '').trim().toUpperCase();
    if (!code) { setPromoStatus({ ok: false, message: 'Enter a promo code.' }); return; }
    if (!serviceItemId) { setPromoStatus({ ok: false, message: 'Select a service first.' }); return; }
    setPromoChecking(true);
    try {
      const res = await bookingsApi.validatePromo({
        facility_type: serviceItemId,
        customer: isWalkIn ? null : customerId,
        club: clubId || null,
        add_ons: addOnsSel || [],
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        booking_type: bookingType,
        code,
      });
      if (res.valid) {
        setAppliedCode(res.code);
        setPromoStatus({ ok: true, message: res.message, discount: res.discount, currency: res.currency });
      } else {
        setAppliedCode('');
        setPromoStatus({ ok: false, message: res.message || 'Invalid promo code.' });
      }
    } catch (e) {
      setPromoStatus({ ok: false, message: apiErrorMessage(e, t('unableValidatePromoCodePlease')) });
    } finally {
      setPromoChecking(false);
    }
  }

  function clearPromo() {
    setAppliedCode('');
    setPromoStatus(null);
    setValue('promo_code_input', '');
  }

  function close() {
    reset();
    setPickedCustomer(null);
    setAppliedCode('');
    setPromoStatus(null);
    setConflict(null);
    onClose?.();
  }

  async function onSubmit(values, override = false, asDraft = false,
                          finishing = false) {
    try {
      const walkIn = values.booking_type === 'walk_in';
      const payload = {
        facility_type: Number(values.facility_type),
        add_ons: (values.add_ons || []).map(Number),
        booking_type: values.booking_type || 'advance',
        priority: values.priority || 'normal',
        scheduled_date: values.scheduled_date,
        scheduled_time: values.scheduled_time,
        recurrence: values.recurrence,
        payment_status: values.payment_status || 'pending',
        payment_method: values.payment_method || '',
        customer_notes: values.customer_notes || '',
        internal_notes: values.internal_notes || '',
        special_instructions: values.special_instructions || '',
        promo_code_input: appliedCode,   // only the explicitly-applied code is sent
        assigned_to: values.assigned_to ? Number(values.assigned_to) : null,
        club: values.club ? Number(values.club) : null,
      };
      if (override) payload.override = true;   // force past an availability conflict
      // Creation only, and the backend ignores it on an edit: a real booking
      // must never be demoted back into an unfinished form, which would take
      // its court away without cancelling anything.
      if (asDraft) payload.save_as_draft = true;
      if (walkIn) {
        payload.walk_in_name = values.walk_in_name || '';
        payload.walk_in_phone = values.walk_in_phone || '';
        payload.walk_in_email = values.walk_in_email || '';
      } else {
        payload.customer = values.customer ? Number(values.customer) : null;
      }
      payload.facility = values.facility ? Number(values.facility) : null;
      let booking;
      if (isEdit) {
        booking = await bookingsApi.update(editId, payload);   // gated by bookings.edit + ownership
      } else if (initial) {
        booking = await bookingsApi.duplicate(payload);        // gated by bookings.duplicate
      } else {
        booking = await bookingsApi.create(payload);
      }
      // Finishing is a separate step because it is the first moment the
      // court is claimed, and it can legitimately fail when the slot has gone
      // while the draft was sitting there. Saving the edits first means the
      // admin never loses their typing to that refusal.
      if (finishing && booking?.id) {
        try {
          booking = await bookingsApi.finishDraft(booking.id);
        } catch (err) {
          toast.error(apiErrorMessage(err, t('unableSaveBookingPleaseTry')));
          onSaved?.(booking);
          return;
        }
      }
      reset();
      setAppliedCode('');
      setPromoStatus(null);
      setConflict(null);
      onSaved?.(booking);
    } catch (e) {
      const data = e?.response?.data;
      if (e?.response?.status === 409 && data?.code === 'availability') {
        // The assigned worker/facility isn't free. Mirror the assign dialog: offer
        // "Save anyway" when the user may override, otherwise just block.
        if (data.overridable) {
          setConflict(data.detail);
        } else {
          setConflict(null);
          toast.error(data.detail);
        }
        return;
      }
      toast.error(apiErrorMessage(e, isEdit
        ? t('unableSaveBookingPleaseTry')
        : t('unableCreateBookingPleaseTry')));
    }
  }

  return (
    <>
    <Modal
      open={open} onClose={close}
      title={isEdit ? 'Edit booking' : initial ? t('duplicateBooking') : t('newBooking')} size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={close} type="button">{t('common:actions.cancel')}</button>
          {canDraft && (
            /* Deliberately NOT behind handleSubmit: a draft exists precisely
               because the form is not finished, so running the required-field
               rules over it would refuse to save the thing it is for.
               `getValues` takes whatever has been typed so far. */
            <button
              className="btn btn-secondary"
              onClick={() => onSubmit(getValues(), false, true)}
              disabled={isSubmitting}
              type="button"
            >
              {isSubmitting ? t('common:state.saving') : t('saveAsDraft')}
            </button>
          )}
          {conflict ? (
            <button
              className="btn btn-warning"
              onClick={handleSubmit((v) => onSubmit(v, true))}
              disabled={isSubmitting}
              type="button"
            >
              {isSubmitting ? t('common:state.saving') : t('saveAnyway')}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleSubmit((v) => onSubmit(v, false, false, editingDraft))}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? (isEdit ? t('common:state.saving') : t('creating'))
                : (editingDraft ? t('finishBooking')
                  : isEdit ? t('common:actions.saveChanges') : t('createBooking'))}
            </button>
          )}
        </>
      }
    >
      {lockedExceptNotes && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }} role="alert">
          <strong>{t('bookingClosed')}</strong> Reopen it to change its details - only the
          Customer Notes and Internal Notes can be edited here.
        </div>
      )}
      {/* When closed, every field except the notes below is locked (matches the
          backend rule: only customer/internal notes are editable). `disabled`
          covers native controls; `pointer-events:none` also locks the custom
          dropdowns (Select2 etc.) which a fieldset alone can't disable. */}
      <fieldset disabled={lockedExceptNotes}
        style={{
          border: 'none', padding: 0, margin: 0, minInlineSize: 0,
          ...(lockedExceptNotes ? { pointerEvents: 'none', opacity: 0.6 } : {}),
        }}>
      {conflict && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }} role="alert">
          <strong>{t('availabilityConflict')}</strong> {conflict}{' '}
          You can change the staff member, facility, date or time - or use “Save anyway” to override.
        </div>
      )}

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>
        <input type="checkbox" checked={isWalkIn}
          onChange={(e) => setValue('booking_type', e.target.checked ? 'walk_in' : 'advance')} />
        {t('walkCustomerNoAccountNeeded')}
      </label>

      {isWalkIn ? (
        <>
        <div className="row">
          <div className="col"><FormField label={t('customerName')} hint={t('optionalWalk')}>
            <input className="form-input" {...register('walk_in_name')} placeholder={t('walkCustomer')} />
          </FormField></div>
          <div className="col"><FormField label={`Mobile number${walkRules.phone_required ? ' *' : ''}`}
            hint={walkRules.phone_required ? t('common:state.required') : t('common:state.optional')}
            error={errors.walk_in_phone?.message}>
            <Controller name="walk_in_phone" control={control}
              rules={{ validate: (v) => {
                if (walkRules.phone_required && !(v || '').trim()) return 'Required';
                return isMobileValid(v) || 'Enter a valid mobile number';
              } }}
              render={({ field }) => (
                <PhoneField value={field.value} onChange={field.onChange} invalid={!!errors.walk_in_phone} />
              )} />
          </FormField></div>
          <div className="col"><FormField label={`Email${walkRules.email_required ? ' *' : ''}`}
            hint={walkRules.email_required ? t('common:state.required') : t('common:state.optional')} error={errors.walk_in_email?.message}>
            <input className="form-input" type="email"
              {...register('walk_in_email', { required: walkRules.email_required ? 'Required' : false })} />
          </FormField></div>
        </div>
        {walkMatch && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12,
            background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning, #f59e0b)',
          }}>
            <span>This {walkMatch.field === 'phone' ? 'mobile number' : 'email'} belongs to a registered customer: <strong>{walkMatch.name || walkMatch.code}</strong>.</span>
            <button type="button" className="btn btn-secondary" onClick={useExistingWalkIn}>{t('useExistingCustomer')}</button>
          </div>
        )}
        </>
      ) : (
        <FormField label={t('common:labels.customer')} error={errors.customer?.message}
          hint={t('searchNameMobileEmailNo')}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Controller
                name="customer" control={control} rules={{ required: 'Required' }}
                render={({ field }) => {
                  const opts = customers.rows.map((c) => ({ value: c.id, label: customerLabel(c) }));
                  // Pin the chosen customer so its label survives a server search
                  // that no longer returns it.
                  if (pickedCustomer && !opts.some((o) => String(o.value) === String(pickedCustomer.value))) {
                    opts.unshift(pickedCustomer);
                  }
                  return (
                    <Select2
                      options={opts}
                      value={field.value || ''}
                      onChange={(v) => {
                        field.onChange(v);
                        const c = customers.rows.find((x) => String(x.id) === String(v));
                        if (c) setPickedCustomer({ value: c.id, label: customerLabel(c) });
                      }}
                      onSearch={(term) => customers.setQuery({ search: term })}
                      placeholder={t('searchNameMobileEmail')}
                      error={errors.customer?.message}
                    />
                  );
                }}
              />
            </div>
            {hasPerm('customers.add') && (
              <button type="button" className="btn btn-secondary" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} onClick={() => setNewCustomerOpen(true)}>
                + New customer
              </button>
            )}
          </div>
        </FormField>
      )}

      <div className="row">
        <div className="col">
          <FormField label={t('facilityCategory')} error={errors.category?.message}>
            <Controller
              name="category" control={control} rules={{ required: 'Required' }}
              render={({ field }) => (
                <Select2
                  options={categories.rows.map((c) => ({ value: c.id, label: c.name }))}
                  value={field.value || ''}
                  onChange={(v) => { field.onChange(v); setValue('facility_type', ''); }}
                  placeholder={t('chooseCategory')} error={errors.category?.message}
                />
              )}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('facilityType')} error={errors.facility_type?.message}
            hint={t('drivesPriceSlotLengthWhich')}>
            <Controller
              name="facility_type" control={control} rules={{ required: 'Required' }}
              render={({ field }) => (
                <Select2
                  options={facilityTypeOptions}
                  value={field.value || ''}
                  onChange={(v) => { field.onChange(v); setValue('facility', ''); setValue('scheduled_time', ''); }}
                  placeholder={categoryId ? t('chooseFacilityType') : t('pickCategoryFirst')}
                  disabled={!categoryId} error={errors.facility_type?.message}
                />
              )}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('addOns')} hint={t('optionalExtrasBooking')}>
            <Controller
              name="add_ons" control={control}
              render={({ field }) => (
                <Select2
                  multiple
                  options={addonOptions}
                  value={field.value || []} onChange={field.onChange}
                  placeholder={serviceItemId ? t('addExtras') : t('pickServiceFirst')}
                  disabled={!serviceItemId}
                />
              )}
            />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('priority')}>
            <Controller
              name="priority" control={control}
              render={({ field }) => (
                <Select2 options={bookingPriorities(t)} value={field.value || 'normal'} onChange={field.onChange} />
              )}
            />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('recurrence')} hint={t('generateRepeatsLaterBookingDetail')}>
            <Controller
              name="recurrence" control={control}
              render={({ field }) => (
                <Select2 options={recurrenceRules(t)} value={field.value} onChange={field.onChange} />
              )}
            />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('club')} error={errors.club?.message}
            hint={t('setsWhichScheduleSlotsFollow')}>
            <Controller
              name="club" control={control} rules={{ required: 'Required' }}
              render={({ field }) => (
                <Select2
                  options={clubs.rows.map((s) => ({ value: s.id, label: s.name }))}
                  value={field.value || ''}
                  onChange={(v) => { field.onChange(v); setValue('facility', ''); setValue('assigned_to', ''); }}
                  placeholder={t('chooseClub')}
                  error={errors.club?.message}
                />
              )}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('common:labels.facility')}
            hint={t('leaveBlankSystemAllocatesFree')}>
            <Controller
              name="facility" control={control}
              render={({ field }) => (
                <Select2
                  options={facilityOptions}
                  value={field.value || ''} onChange={field.onChange}
                  placeholder={clubId ? t('autoAllocate') : t('pickClubFirst')}
                  disabled={!clubId} clearable
                />
              )}
            />
          </FormField>
        </div>
      </div>

      <FormField label={t('assignedStaff')} hint={t('optionalCanAlsoAssignedLater')}>
        <Controller
          name="assigned_to" control={control}
          render={({ field }) => (
            <Select2 options={staffOptions} value={field.value || ''} onChange={field.onChange}
              placeholder={t('common:state.unassigned')} clearable />
          )}
        />
      </FormField>

      <div className="row">
        <div className="col">
          <FormField label={t('common:labels.date')} error={errors.scheduled_date?.message}>
            <Controller
              name="scheduled_date" control={control} rules={{ required: 'Required' }}
              render={({ field }) => (
                <DateCalendar
                  value={field.value || ''} closedWeekdays={closedWeekdays}
                  minDate={window_?.earliest_date || todayISO()}
                  maxDate={window_?.latest_date || undefined}
                  onChange={(v) => { field.onChange(v); setValue('scheduled_time', ''); }}
                />
              )}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField
            label={t('timeSlot')}
            error={errors.scheduled_time?.message}
            hint={slotsLoading
              ? 'Checking availability…'
              : (scheduledDate && slots.length === 0 ? 'Closed / no slots for this club on that date.' : undefined)}
          >
            <Controller
              name="scheduled_time" control={control} rules={{ required: 'Pick a slot' }}
              render={({ field }) => (
                <Select2
                  options={slots.map((s) => ({
                    value: s.time,
                    label: `${formatTime(s.time)} - ${slotState(s)}`,
                    disabled: s.available <= 0,
                  }))}
                  value={field.value || ''} onChange={field.onChange}
                  placeholder={t('chooseSlot')} error={errors.scheduled_time?.message}
                />
              )}
            />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('paymentStatus2')}>
            <Controller
              name="payment_status" control={control}
              render={({ field }) => (
                <Select2 options={paymentStatuses(t)} value={field.value || 'pending'} onChange={field.onChange} />
              )}
            />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('paymentMethod')}>
            <Controller
              name="payment_method" control={control}
              render={({ field }) => (
                <Select2 options={paymentMethods(t)} value={field.value || ''} onChange={field.onChange}
                  placeholder={t('common:state.notSet')} clearable />
              )}
            />
          </FormField>
        </div>
      </div>

      <FormField label={t('promoCode')} hint={t('optionalEnterCodeClickApply')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            {...register('promo_code_input')}
            placeholder={t('eGWelcome10')}
            style={{ textTransform: 'uppercase', flex: 1 }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPromo(); } }}
          />
          {appliedCode ? (
            <button type="button" className="btn btn-secondary" onClick={clearPromo}>{t('common:actions.remove')}</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={applyPromo}
                    disabled={promoChecking || !(promoInput || '').trim()}>
              {promoChecking ? t('checking') : t('common:actions.apply')}
            </button>
          )}
        </div>
        {promoStatus && (
          <div style={{
            marginTop: 6, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
            color: promoStatus.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #dc2626)',
          }}>
            <span>{promoStatus.ok ? '✓' : '✕'}</span>
            <span>
              {promoStatus.message}
              {promoStatus.ok && Number(promoStatus.discount) > 0
                && <> - you save <strong>{formatMoney(promoStatus.discount, promoStatus.currency)}</strong></>}
            </span>
          </div>
        )}
      </FormField>

      {/* Membership coverage (what the active membership covers vs charges) */}
      {preview?.coverage && (
        <>
          <div className="modal-section">{t('membershipCoverageSummary')}</div>
          <MembershipCoverageSummary coverage={preview.coverage} />
        </>
      )}

      {/* Live, backend-computed Price Calculation Summary */}
      <div className="modal-section">{t('priceCalculationSummary')}</div>
      <PriceSummary hasService={!!serviceItemId} loading={previewLoading} preview={preview} />
      </fieldset>

      {/* Notes stay editable even on a closed booking (outside the locked fieldset). */}
      <FormField label={t('customerNotes')}>
        <textarea className="form-textarea" rows={2} {...register('customer_notes')} />
      </FormField>
      <FormField label={t('internalNotes')} hint={t('staffOnlyNotShownCustomer')}>
        <textarea className="form-textarea" rows={2} {...register('internal_notes')} />
      </FormField>
      <FormField label={t('specialInstructions')}>
        <textarea className="form-textarea" rows={2} disabled={lockedExceptNotes}
          {...register('special_instructions')} />
      </FormField>
    </Modal>

    {/* Quick-create a Customer (no login) without leaving the booking flow. */}
    <CustomerFormModal
      open={newCustomerOpen}
      onClose={() => setNewCustomerOpen(false)}
      onSaved={(created) => {
        setNewCustomerOpen(false);
        toast.success(t('customerCreated'));
        customers.reload();
        if (created?.id) {
          setPickedCustomer({ value: created.id, label: customerLabel(created) });
          setValue('customer', created.id);
        }
      }}
    />

    </>
  );
}
