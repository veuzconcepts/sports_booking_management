import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { PhoneField, isMobileValid } from '../../components/PhoneField.jsx';
import { customersApi } from '../../services/customersService.js';
import { useBookingConfig } from '../../hooks/useBookingConfig.js';
import { apiErrorMessage } from '../../utils/apiError';

const customerSources = (t) => [
  { value: 'web', label: t('website') },
  { value: 'admin', label: t('admin') },
  { value: 'walk_in', label: t('walk') },
  { value: 'referral', label: t('referral') },
  { value: 'other', label: t('other') },
];

const customerTypes = (t) => [
  { value: 'individual', label: t('individual') },
  { value: 'corporate', label: t('corporate') },
  { value: 'fleet', label: t('fleet') },
];

export function CustomerFormModal({ open, onClose, onSaved, onUseExisting }) {
  const { t } = useTranslation('customers');
  const { register, handleSubmit, reset, control, watch, formState: { errors, isSubmitting } } =
    useForm({ defaultValues: { source: 'walk_in', customer_type: 'individual' } });
  const { rulesFor } = useBookingConfig();
  const rules = rulesFor('admin');

  // Detect an existing customer by phone/email so staff can reuse instead of
  // creating a duplicate (the server hard-blocks duplicates too).
  const phone = watch('mobile_number');
  const email = watch('email');
  const [match, setMatch] = useState(null);
  useEffect(() => {
    const p = (phone || '').trim();
    const e = (email || '').trim();
    if (!p && !e) { setMatch(null); return undefined; }
    const t = setTimeout(() => {
      customersApi.lookup({ phone: p, email: e })
        .then((r) => setMatch(r?.match || null)).catch(() => setMatch(null));
    }, 400);
    return () => clearTimeout(t);
  }, [phone, email]);

  async function onSubmit(values) {
    try {
      // Creates a CUSTOMER ONLY - no login. A mobile login can be provisioned
      // afterwards from the customer's detail page (Login Access).
      const created = await customersApi.create({
        ...values,
        is_corporate: values.customer_type !== 'individual',
        is_fleet: values.customer_type === 'fleet',
      });
      reset();
      onSaved?.(created);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableCreateCustomerPleaseTry')));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('newCustomer')}
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('createCustomer')}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} id="customer-form">
        <FormField label={t('fullName')} error={errors.full_name?.message}>
          <input className="form-input" {...register('full_name', { required: 'Required' })} />
        </FormField>

        <div className="row">
          <div className="col">
            <FormField label={`Mobile number${rules.phone_required ? ' *' : ''}`}
              hint={t('recommendedUsedFindCustomer')}
              error={errors.mobile_number?.message}>
              <Controller name="mobile_number" control={control}
                rules={{ validate: (v) => {
                  if (rules.phone_required && !(v || '').trim()) return 'Required';
                  return isMobileValid(v) || 'Enter a valid mobile number';
                } }}
                render={({ field }) => (
                  <PhoneField value={field.value} onChange={field.onChange} invalid={!!errors.mobile_number} />
                )} />
            </FormField>
          </div>
          <div className="col">
            <FormField label={`Email${rules.email_required ? ' *' : ''}`}
              hint={rules.email_required ? t('common:state.required') : t('common:state.optional')} error={errors.email?.message}>
              <input className="form-input" type="email"
                {...register('email', { required: rules.email_required ? 'Required' : false })} />
            </FormField>
          </div>
        </div>

        {match && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12,
            background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning, #f59e0b)',
          }}>
            <span>An existing customer matches this {match.field === 'phone' ? 'mobile number' : 'email'}: <strong>{match.name || match.code}</strong>.</span>
            <button type="button" className="btn btn-secondary"
              onClick={() => { (onUseExisting || onSaved)?.(match); reset(); setMatch(null); }}>
              {t('useExisting')}
            </button>
          </div>
        )}

        <div className="row">
          <div className="col">
            <FormField label={t('customerType')}>
              <Controller name="customer_type" control={control} render={({ field }) => (
                <Select2 options={customerTypes(t)} value={field.value} onChange={field.onChange} />
              )} />
            </FormField>
          </div>
          <div className="col">
            <FormField label={t('sourceLabel')} hint={t('whereDidCustomerCome')}>
              <Controller name="source" control={control} render={({ field }) => (
                <Select2 options={customerSources(t)} value={field.value} onChange={field.onChange} />
              )} />
            </FormField>
          </div>
        </div>

        <FormField label={t('trnTaxRegistrationNumber')} hint={t('optionalVatRegisteredB2bCustomers')}>
          <input className="form-input" {...register('trn')} placeholder="100xxxxxxxxxxxx" />
        </FormField>

        <FormField label={t('common:labels.notes')}>
          <textarea className="form-textarea" rows={3} {...register('notes')} />
        </FormField>

        <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          {t('noLoginCreatedYouCan')}
        </p>
      </form>
    </Modal>
  );
}
