import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { Controller, useForm } from 'react-hook-form';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  EMPLOYMENT_TYPES,
  STAFF_ROLE_OPTIONS,
  staffApi,
} from '../../services/staffService.js';
import { clubsApi } from '../../services/clubsService.js';
import { apiErrorMessage } from '../../utils/apiError';

export default function StaffListPage() {
  const { hasPerm } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();
  const fetcher = useCallback((q) => staffApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="The people who run your clubs and their facilities."
        actions={
          hasPerm('staff.add') && (
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
              <Plus size={15} /> Add staff
            </button>
          )
        }
      />

      <Toolbar
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Name, employee ID, skills…"
        filters={[
          {
            value: query.user__role,
            options: STAFF_ROLE_OPTIONS,
            placeholder: 'All roles',
            onChange: (v) => setQuery({ ...query, user__role: v, page: 1 }),
          },
          {
            value: query.is_available,
            options: [
              { value: 'true',  label: 'Available' },
              { value: 'false', label: 'Unavailable' },
            ],
            placeholder: 'Availability',
            onChange: (v) => setQuery({ ...query, is_available: v, page: 1 }),
          },
        ]}
      />

      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(r) => navigate(`/staff/${r.id}`)}
        emptyTitle="No staff yet"
        emptyHint="Add staff members and facility operators here."
        columns={[
          {
            key: 'name', header: 'Staff',
            render: (r) => (
              <div>
                <button className="link-btn" style={{ fontWeight: 600 }}
                  onClick={(e) => { e.stopPropagation(); navigate(`/staff/${r.id}`); }}>{r.full_name}</button>
                <div className="muted" style={{ fontSize: 12 }}>{r.employee_id} · {r.email}</div>
              </div>
            ),
          },
          { key: 'role', header: 'Role', render: (r) => <StatusBadge tone="info" label={r.role} /> },
          {
            key: 'employment', header: 'Employment',
            render: (r) => (r.employment_type || '').replace('_', ' '),
          },
          {
            key: 'rating', header: 'Rating',
            render: (r) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Star size={13} color="#f59e0b" /> {Number(r.rating).toFixed(1)}
              </span>
            ),
          },
          {
            key: 'available', header: 'Status',
            render: (r) => (
              <StatusBadge tone={r.is_available ? 'success' : 'muted'}
                           label={r.is_available ? 'Available' : 'Off'} />
            ),
          },
        ]}
      />

      <StaffFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success('Staff member added'); reload(); }}
      />
    </>
  );
}

function StaffFormModal({ open, onClose, onSaved }) {
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
      toast.error(apiErrorMessage(e, 'Unable to add the staff member. Please try again.'));
    }
  }

  return (
    <Modal
      open={open} onClose={onClose} title="Add staff member" size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Save staff'}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="col">
          <FormField label="First name" error={errors.first_name?.message}>
            <input className="form-input" {...register('first_name', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Last name" error={errors.last_name?.message}>
            <input className="form-input" {...register('last_name', { required: 'Required' })} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label="Email" error={errors.email?.message}>
            <input className="form-input" type="email" {...register('email', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Phone">
            <input className="form-input" {...register('phone')} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label="Employee ID" error={errors.employee_id?.message}>
            <input className="form-input" {...register('employee_id', { required: 'Required' })} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Role">
            <Controller name="role" control={control} render={({ field }) => (
              <Select2 options={STAFF_ROLE_OPTIONS} value={field.value} onChange={field.onChange} placeholder="Select role…" />
            )} />
          </FormField>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <FormField label="Employment type">
            <Controller name="employment_type" control={control} render={({ field }) => (
              <Select2 options={EMPLOYMENT_TYPES} value={field.value} onChange={field.onChange} placeholder="Select type…" />
            )} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Base club">
            <Controller name="base_site" control={control}
              render={({ field }) => (
                <Select2
                  options={clubs.map((s) => ({ value: s.id, label: s.name }))}
                  value={field.value || ''} onChange={field.onChange}
                  placeholder="Select a club…" clearable
                />
              )} />
          </FormField>
        </div>
      </div>

      <FormField label="Skills" hint="Comma-separated, e.g. ceramic, polish, interior.">
        <input className="form-input" {...register('skills')} />
      </FormField>

      <FormField label="Temporary password" hint="Leave blank to auto-generate.">
        <input className="form-input" type="text" {...register('password')} />
      </FormField>
    </Modal>
  );
}
