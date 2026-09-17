import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Star, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Controller, useForm } from 'react-hook-form';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  employmentTypes,
  staffRoleOptions,
  staffApi,
} from '../../services/staffService.js';
import { clubsApi } from '../../services/clubsService.js';
import { useFilterOptions, asOptions } from '../../hooks/useFilterOptions.js';
import { apiErrorMessage } from '../../utils/apiError';

const GROUP_KEYS = [
  ['user__role', 'groups.role'],
  ['employment_type', 'groups.employment'],
  ['base_club', 'groups.club'],
  ['is_available', 'groups.availability'],
];

export default function StaffListPage() {
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();
  const fetcher = useCallback((q) => staffApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const { clubs } = useFilterOptions();
  const { t } = useTranslation('staff');
  const { t: tc } = useTranslation('common');


  const columns = useMemo(() => [
    { key: 'name', header: t('columns.staff'), sortKey: 'employee_id', minWidth: 200,
      alwaysVisible: true,
      render: (r) => (
        <div>
          <span className="link-btn" style={{ fontWeight: 600 }}>{r.full_name}</span>
          <div className="muted" style={{ fontSize: 12 }}>{r.employee_id} · {r.email}</div>
        </div>
      ) },
    { key: 'role', header: t('columns.role'), minWidth: 120,
      render: (r) => <StatusBadge tone="info" label={r.role} /> },
    { key: 'employment', header: t('columns.employment'), minWidth: 120, priority: 'medium',
      render: (r) => (r.employment_type || '').replace('_', ' ') },
    { key: 'rating', header: t('columns.rating'), sortKey: 'rating', minWidth: 90,
      priority: 'low',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Star size={13} color="#f59e0b" /> {Number(r.rating).toFixed(1)}
        </span>
      ) },
    { key: 'available', header: t('columns.status'), minWidth: 110,
      render: (r) => (
        <StatusBadge tone={r.is_available ? 'success' : 'muted'}
          label={r.is_available ? t('availability.available') : t('availability.off')} />
      ) },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'user__role', label: t('filters.role'), type: 'select', options: staffRoleOptions(t) },
    { key: 'employment_type', label: t('filters.employment'), type: 'select',
      options: employmentTypes(t) },
    { key: 'base_club', label: t('filters.club'), type: 'select', options: asOptions(clubs) },
    { key: 'is_available', label: t('filters.availability'), type: 'boolean',
      trueLabel: t('availability.available'), falseLabel: t('availability.unavailable') },
  ], [clubs, t]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, labelKey]) => ({ key, label: t(labelKey) })), [t]);

  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => navigate(`/staff/${row.id}`) },
  ], [navigate]);

  return (
    <ListPage
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        hasPerm('staff.add') && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={15} /> {t('addStaff')}
          </button>
        )
      }
    >
      <ListView
        tableKey="staff"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="employee_id"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        onRowClick={(r) => navigate(`/staff/${r.id}`)}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
      />

      <StaffFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('actions.added')); reload(); }}
      />
    </ListPage>
  );
}

function StaffFormModal({ open, onClose, onSaved }) {
  const { t } = useTranslation('staff');
  const { register, handleSubmit, reset, control, formState: { errors, isSubmitting } } = useForm({
    defaultValues: { role: 'facility_staff', employment_type: 'full_time' },
  });
  const [clubs, setSites] = useState([]);
  useEffect(() => {
    if (open) clubsApi.list({ is_active: 'true', page_size: 200 })
      .then((d) => setSites(d.results || d)).catch(() => setSites([]));
  }, [open]);

  async function onSubmit(values) {
    try {
      await staffApi.create({ ...values, base_site: values.base_site || null });
      reset();
      onSaved?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('unableAddStaffMemberPlease')));
    }
  }

  return (
    <Modal
      open={open} onClose={onClose} title={t('addStaffMember')} size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} type="button">{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? t('common:state.saving') : t('saveStaff')}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="col">
          <FormField label={t('firstName')} error={errors.first_name?.message}>
            <input className="form-input" {...register('first_name', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('lastName')} error={errors.last_name?.message}>
            <input className="form-input" {...register('last_name', { required: 'Required' })} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('common:labels.email')} error={errors.email?.message}>
            <input className="form-input" type="email" {...register('email', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('common:labels.phone')}>
            <input className="form-input" {...register('phone')} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('employeeId')} error={errors.employee_id?.message}>
            <input className="form-input" {...register('employee_id', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('role')}>
            <Controller name="role" control={control} render={({ field }) => (
              <Select2 options={staffRoleOptions(t)} value={field.value} onChange={field.onChange} placeholder={t('selectRole')} />
            )} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label={t('employmentType')}>
            <Controller name="employment_type" control={control} render={({ field }) => (
              <Select2 options={employmentTypes(t)} value={field.value} onChange={field.onChange} placeholder={t('selectType')} />
            )} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('baseClub')}>
            <Controller name="base_site" control={control}
              render={({ field }) => (
                <Select2
                  options={clubs.map((s) => ({ value: s.id, label: s.name }))}
                  value={field.value || ''} onChange={field.onChange}
                  placeholder={t('selectClub')} clearable
                />
              )} />
          </FormField>
        </div>
      </div>

      <FormField label={t('skills')} hint={t('commaSeparatedEGCeramic')}>
        <input className="form-input" {...register('skills')} />
      </FormField>

      <FormField label={t('temporaryPassword')} hint={t('leaveBlankAutoGenerate')}>
        <input className="form-input" type="text" {...register('password')} />
      </FormField>
    </Modal>
  );
}
