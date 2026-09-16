import { useCallback, useState } from 'react';
import { Plus, Send } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { formatDateTime } from '../../services/timeformat.jsx';
import { apiErrorMessage } from '../../utils/apiError';

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  notificationsApi,
  templatesApi,
} from '../../services/notificationsService.js';

const TABS = [
  { key: 'log',       label: 'Delivery log' },
  { key: 'templates', label: 'Templates' },
];
const tabBtnStyle = (active) => ({
  padding: '8px 14px', border: 'none', background: 'transparent',
  borderBottom: active ? '2px solid var(--color-primary-600)' : '2px solid transparent',
  color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
  fontWeight: 600, fontSize: 13.5, cursor: 'pointer',
});
const ADMINS = ['super_admin', 'admin'];

export default function NotificationsPage() {
  const [tab, setTab] = useTabParam('log');
  return (
    <>
      <PageHeader title="Notifications" subtitle="Delivery log and message templates." />
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 18 }}>
        {TABS.map((t) => (
          <button key={t.key} style={tabBtnStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'log' ? <LogTab /> : <TemplatesTab />}
    </>
  );
}

function LogTab() {
  const fetcher = useCallback((q) => notificationsApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher);

  async function resend(n) {
    try { await notificationsApi.resend(n.id); toast.success('Resent'); reload(); }
    catch (e) { toast.error(apiErrorMessage(e, 'Unable to resend the notification. Please try again.')); }
  }

  return (
    <>
      <Toolbar
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Recipient, subject…"
        filters={[
          { value: query.status, options: NOTIFICATION_STATUSES, placeholder: 'All statuses',
            onChange: (v) => setQuery({ ...query, status: v, page: 1 }) },
          { value: query.channel, options: NOTIFICATION_CHANNELS, placeholder: 'All channels',
            onChange: (v) => setQuery({ ...query, channel: v, page: 1 }) },
        ]}
      />
      <DataTable
        loading={loading}
        rows={rows}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        emptyTitle="No notifications yet"
        emptyHint="Notifications are sent automatically on booking and payment events."
        columns={[
          { key: 'when', header: 'Sent', render: (r) => formatDateTime(r.created_at) },
          { key: 'to', header: 'Recipient', render: (r) => (
            <div>{r.recipient_name || r.to_address}<div className="muted" style={{ fontSize: 12 }}>{r.to_address}</div></div>
          ) },
          { key: 'event', header: 'Event', render: (r) => r.event || '-' },
          { key: 'channel', header: 'Channel', render: (r) => <StatusBadge tone="info" label={r.channel} /> },
          { key: 'status', header: 'Status', render: (r) => (
            <StatusBadge tone={r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'} label={r.status} />
          ) },
          { key: 'actions', header: '', render: (r) => (
            <button className="icon-btn" title="Resend" onClick={() => resend(r)}><Send size={15} /></button>
          ) },
        ]}
      />
    </>
  );
}

function TemplatesTab() {
  const { role } = useAuth();
  const canEdit = ADMINS.includes(role);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const fetcher = useCallback((q) => templatesApi.list(q), []);
  const { rows, loading, reload } = useApiList(fetcher);

  function openNew() { setEditing(null); setModalOpen(true); }
  function openEdit(t) { setEditing(t); setModalOpen(true); }

  return (
    <>
      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-primary" onClick={openNew}><Plus size={15} /> New template</button>
        </div>
      )}
      <DataTable
        loading={loading}
        rows={rows}
        onRowClick={canEdit ? openEdit : undefined}
        emptyTitle="No templates yet"
        emptyHint="Create templates the dispatcher renders for each event."
        columns={[
          { key: 'code', header: 'Code', render: (r) => <code style={{ fontWeight: 600 }}>{r.code}</code> },
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'channel', header: 'Channel', render: (r) => <StatusBadge tone="info" label={r.channel} /> },
          { key: 'subject', header: 'Subject', render: (r) => <span className="muted">{r.subject || '-'}</span> },
          { key: 'active', header: 'Status', render: (r) => (
            <StatusBadge tone={r.is_active ? 'success' : 'muted'} label={r.is_active ? 'Active' : 'Inactive'} />
          ) },
        ]}
      />
      <TemplateModal
        open={modalOpen} template={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success('Template saved'); reload(); }}
      />
    </>
  );
}

function TemplateModal({ open, template, onClose, onSaved }) {
  const isEdit = Boolean(template);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  // Sync local form when the modal opens for a given template.
  const current = {
    code: '', name: '', channel: 'email', subject: '', body: '', is_active: true,
    ...(template || {}), ...form,
  };

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  async function submit() {
    setBusy(true);
    try {
      const payload = {
        code: current.code, name: current.name, channel: current.channel,
        subject: current.subject, body: current.body, is_active: current.is_active,
      };
      if (isEdit) await templatesApi.update(template.id, payload);
      else await templatesApi.create(payload);
      setForm({});
      onSaved?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to save your changes. Please try again.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open} onClose={() => { setForm({}); onClose(); }}
      title={isEdit ? `Edit ${template.code}` : 'New template'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={() => { setForm({}); onClose(); }}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>Save</button>
      </>}
    >
      <div className="row">
        <div className="col">
          <FormField label="Code" hint="Stable id, e.g. booking_confirmed.">
            <input className="form-input" value={current.code} disabled={isEdit}
                   onChange={(e) => set('code', e.target.value)} />
          </FormField>
        </div>
        <div className="col">
          <FormField label="Channel">
            <Select2 options={NOTIFICATION_CHANNELS} value={current.channel}
                     onChange={(v) => set('channel', v)} />
          </FormField>
        </div>
      </div>
      <FormField label="Name">
        <input className="form-input" value={current.name} onChange={(e) => set('name', e.target.value)} />
      </FormField>
      <FormField label="Subject" hint="Supports {placeholders}.">
        <input className="form-input" value={current.subject} onChange={(e) => set('subject', e.target.value)} />
      </FormField>
      <FormField label="Body" hint="Supports {placeholders} from the event context.">
        <textarea className="form-textarea" rows={5} value={current.body} onChange={(e) => set('body', e.target.value)} />
      </FormField>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={current.is_active} onChange={(e) => set('is_active', e.target.checked)} />
        <span className="muted" style={{ fontSize: 13 }}>Active</span>
      </label>
    </Modal>
  );
}
