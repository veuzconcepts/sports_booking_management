import { useCallback, useMemo, useState } from 'react';
import { Plus, Send, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { PageTabs } from '../../components/PageTabs.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { ListPage, ListView } from '../../components/listview/index.js';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { formatDateTime } from '../../services/timeformat.jsx';
import { apiErrorMessage } from '../../utils/apiError';

import {
  notificationChannels,
  notificationStatuses,
  notificationsApi,
  templatesApi,
} from '../../services/notificationsService.js';

const tabs = (t) => [
  { key: 'log',       label: t('deliveryLog') },
  { key: 'templates', label: t('templates2') },
];
const ADMINS = ['super_admin', 'admin'];

const LOG_GROUP_KEYS = [
  ['status', 'log.groups.status'],
  ['channel', 'log.groups.channel'],
  ['event', 'log.groups.event'],
];

const TEMPLATE_GROUP_KEYS = [
  ['channel', 'templates.groups.channel'],
  ['is_active', 'templates.groups.status'],
];

export default function NotificationsPage() {
  const { t } = useTranslation('notifications');
  const [tab, setTab] = useTabParam('log');
  return (
    <ListPage
      title={t('title')}
      subtitle={t('deliveryLogMessageTemplates')}
      tabs={<PageTabs tabs={tabs(t)} active={tab} onChange={setTab} label={t('title')} />}
    >
      {tab === 'log' ? <LogTab /> : <TemplatesTab />}
    </ListPage>
  );
}

function LogTab() {
  const { t } = useTranslation('notifications');
  const fetcher = useCallback((q) => notificationsApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const resend = useCallback(async (n) => {
    try { await notificationsApi.resend(n.id); toast.success(t('log.resent')); reload(); }
    catch (e) { toast.error(apiErrorMessage(e, t('log.resendFailed'))); }
  }, [reload]);

  const columns = useMemo(() => [
    { key: 'when', header: t('log.columns.sent'), sortKey: 'created_at', nowrap: true,
      minWidth: 165, alwaysVisible: true,
      render: (r) => formatDateTime(r.created_at) },
    { key: 'to', header: t('log.columns.recipient'), sortKey: 'to_address', minWidth: 190,
      truncate: true,
      render: (r) => (
        <div>
          {r.recipient_name || r.to_address}
          <div className="muted" style={{ fontSize: 12 }}>{r.to_address}</div>
        </div>
      ) },
    { key: 'event', header: t('log.columns.event'), sortKey: 'event', minWidth: 150,
      truncate: true, render: (r) => r.event || '-' },
    { key: 'channel', header: t('log.columns.channel'), sortKey: 'channel', minWidth: 100,
      render: (r) => <StatusBadge tone="info" label={r.channel} /> },
    { key: 'status', header: t('log.columns.status'), sortKey: 'status', minWidth: 100,
      render: (r) => (
        <StatusBadge
          tone={r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}
          label={r.status} />
      ) },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'status', label: t('log.filters.status'), type: 'select', options: notificationStatuses(t) },
    { key: 'channel', label: t('log.filters.channel'), type: 'select', options: notificationChannels(t) },
  ], [t]);

  const logGroups = useMemo(
    () => LOG_GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const rowActions = useCallback((row) => [
    { key: 'resend', label: t('log.resend'), icon: <Send size={14} />,
      onClick: () => resend(row) },
  ], [resend]);

  return (
    <ListView
      tableKey="notification-log"
      fetcher={fetcher}
      reloadKey={reloadKey}
      defaultOrdering="-created_at"
      searchPlaceholder={t('log.searchPlaceholder')}
      emptyTitle={t('log.emptyTitle')}
      emptyHint={t('log.emptyHint')}
      columns={columns}
      filters={filters}
      groupOptions={logGroups}
      rowActions={rowActions}
    />
  );
}

function TemplatesTab() {
  const { t } = useTranslation('notifications');
  const { role } = useAuth();
  const canEdit = ADMINS.includes(role);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const fetcher = useCallback((q) => templatesApi.list(q), []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const openEdit = useCallback((t) => { setEditing(t); setModalOpen(true); }, []);

  const columns = useMemo(() => [
    { key: 'code', header: t('templates.columns.code'), sortKey: 'code', minWidth: 170,
      alwaysVisible: true,
      render: (r) => <code style={{ fontWeight: 600 }}>{r.code}</code> },
    { key: 'name', header: t('templates.columns.name'), sortKey: 'name', minWidth: 170,
      truncate: true, render: (r) => r.name },
    { key: 'channel', header: t('templates.columns.channel'), sortKey: 'channel', minWidth: 100,
      render: (r) => <StatusBadge tone="info" label={r.channel} /> },
    { key: 'subject', header: t('templates.columns.subject'), minWidth: 200, truncate: true,
      priority: 'medium',
      render: (r) => <span className="muted">{r.subject || '-'}</span> },
    { key: 'active', header: t('templates.columns.status'), sortKey: 'is_active', minWidth: 100,
      render: (r) => (
        <StatusBadge tone={r.is_active ? 'success' : 'muted'}
          label={r.is_active ? t('templates.active', 'Active') : t('templates.inactive', 'Inactive')} />
      ) },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'channel', label: t('templates.filters.channel'), type: 'select', options: notificationChannels(t) },
    { key: 'is_active', label: t('templates.filters.status'), type: 'boolean',
      trueLabel: t('templates.active', 'Active'), falseLabel: t('templates.inactive', 'Inactive') },
  ], [t]);

  const templateGroups = useMemo(
    () => TEMPLATE_GROUP_KEYS.map(([key, k]) => ({ key, label: t(k) })), [t]);

  const rowActions = useCallback((row) => (canEdit ? [
    { key: 'edit', label: t('templates.edit'), icon: <Pencil size={14} />,
      onClick: () => openEdit(row) },
  ] : []), [canEdit, openEdit, t]);

  return (
    <>
      <ListView
        tableKey="notification-templates"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="code"
        searchPlaceholder={t('templates.searchPlaceholder')}
        emptyTitle={t('templates.emptyTitle')}
        emptyHint={t('templates.emptyHint')}
        onRowClick={canEdit ? openEdit : undefined}
        columns={columns}
        filters={filters}
        groupOptions={templateGroups}
        rowActions={canEdit ? rowActions : undefined}
        toolbarRight={canEdit && (
          <button className="btn btn-primary"
            onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus size={15} /> {t('templates.newTemplate')}
          </button>
        )}
      />
      <TemplateModal
        open={modalOpen} template={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setModalOpen(false); toast.success(t('templates.saved')); reload(); }}
      />
    </>
  );
}

function TemplateModal({ open, template, onClose, onSaved }) {
  const { t } = useTranslation('notifications');
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
      toast.error(apiErrorMessage(e, t('unableSaveYourChangesPlease')));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open} onClose={() => { setForm({}); onClose(); }}
      title={isEdit ? `Edit ${template.code}` : 'New template'} size="lg"
      footer={<>
        <button className="btn btn-secondary" type="button" onClick={() => { setForm({}); onClose(); }}>{t('common:actions.cancel')}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{t('common:actions.save')}</button>
      </>}
    >
      <div className="row">
        <div className="col">
          <FormField label={t('code')} hint={t('stableIdEGBooking')}>
            <input className="form-input" value={current.code} disabled={isEdit}
                   onChange={(e) => set('code', e.target.value)} />
          </FormField>
        </div>
        <div className="col">
          <FormField label={t('channel')}>
            <Select2 options={notificationChannels(t)} value={current.channel}
                     onChange={(v) => set('channel', v)} />
          </FormField>
        </div>
      </div>
      <FormField label={t('common:labels.name')}>
        <input className="form-input" value={current.name} onChange={(e) => set('name', e.target.value)} />
      </FormField>
      <FormField label={t('subject')} hint="Supports {placeholders}.">
        <input className="form-input" value={current.subject} onChange={(e) => set('subject', e.target.value)} />
      </FormField>
      <FormField label={t('body')} hint="Supports {placeholders} from the event context.">
        <textarea className="form-textarea" rows={5} value={current.body} onChange={(e) => set('body', e.target.value)} />
      </FormField>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={current.is_active} onChange={(e) => set('is_active', e.target.checked)} />
        <span className="muted" style={{ fontSize: 13 }}>{t('common:state.active')}</span>
      </label>
    </Modal>
  );
}
