import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';

import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { PhoneField, isMobileValid } from '../../components/PhoneField.jsx';
import { customersApi } from '../../services/customersService.js';
import { useBookingConfig } from '../../hooks/useBookingConfig.js';
import { apiErrorMessage } from '../../utils/apiError';

const CUSTOMER_SOURCES = [
  { value: 'web', label: 'Website' },
  { value: 'admin', label: 'Admin' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'referral', label: 'Referral' },
  { value: 'other', label: 'Other' },
];

const CUSTOMER_TYPES = [
  { value: 'individual', label: 'Individual' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'fleet', label: 'Fleet' },
];

export function CustomerFormModal({ open, onClose, onSaved, onUseExisting }) {
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
      toast.error(apiErrorMessage(e, 'Unable to create the customer. Please try again.'));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New customer"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Create customer'}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} id="customer-form">
        <FormField label="Full name" error={errors.full_name?.message}>
          <input className="form-input" {...register('full_name', { required: 'Required' })} />
        </FormField>

        <div className="row">
          <div className="col">
            <FormField label={`Mobile number${rules.phone_required ? ' *' : ''}`}
              hint="Recommended - used to find the customer."
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
              hint={rules.email_required ? 'Required.' : 'Optional.'} error={errors.email?.message}>
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
              Use existing
            </button>
          </div>
        )}

        <div className="row">
          <div className="col">
            <FormField label="Customer type">
              <Controller name="customer_type" control={control} render={({ field }) => (
                <Select2 options={CUSTOMER_TYPES} value={field.value} onChange={field.onChange} />
              )} />
            </FormField>
          </div>
          <div className="col">
            <FormField label="Source" hint="Where did this customer come from?">
              <Controller name="source" control={control} render={({ field }) => (
                <Select2 options={CUSTOMER_SOURCES} value={field.value} onChange={field.onChange} />
              )} />
            </FormField>
          </div>
        </div>

        <FormField label="TRN (Tax Registration Number)" hint="Optional - for VAT-registered (B2B) customers; printed on their tax invoices.">
          <input className="form-input" {...register('trn')} placeholder="100xxxxxxxxxxxx" />
        </FormField>

        <FormField label="Notes">
          <textarea className="form-textarea" rows={3} {...register('notes')} />
        </FormField>

        <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          No login is created. You can provision a mobile login later from the customer’s page.
        </p>
      </form>
    </Modal>
  );
}
