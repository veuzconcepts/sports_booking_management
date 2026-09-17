import { useCallback, useMemo, useState } from 'react';
import { Check, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useLanguage } from '../../i18n/LanguageProvider.jsx';
import { languagesApi } from '../../services/languagesService.js';
import { apiErrorMessage } from '../../utils/apiError';

const groups = (t) => [
  { key: 'direction', label: t('direction') },
  { key: 'is_enabled', label: t('common:labels.status') },
];

const BLANK = {
  code: '', locale: '', name: '', native_name: '',
  direction: 'ltr', is_enabled: true, is_default: false, display_order: 0,
};

/**
 * Language management: which languages the application offers, which is the
 * default, and how each is labelled.
 *
 * Deliberately NOT a translation editor. Enabling a language and translating it
 * are different jobs with different risks: an administrator can safely turn
 * Arabic on or off, but renaming a technical key would break the interface for
 * everyone. The keys live in the build.
 */
export default function LanguagesPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { hasPerm } = useAuth();
  const canManage = hasPerm('settings.manage');

  const [editing, setEditing] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const fetcher = useCallback((q) => languagesApi.list(q), []);

  async function save() {
    const body = {
      ...editing,
      display_order: Number(editing.display_order) || 0,
      locale: editing.locale?.trim() || '',
    };
    if (!body.code || !body.name || !body.native_name) {
      toast.error(t('common:messages.somethingWentWrong'));
      return;
    }
    setBusy(true);
    try {
      if (editing.id) await languagesApi.update(editing.id, body);
      else await languagesApi.create(body);
      toast.success(t('settings:languages.saved'));
      setEditing(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('common:messages.somethingWentWrong')));
    } finally { setBusy(false); }
  }

  async function makeDefault(row) {
    try {
      await languagesApi.makeDefault(row.id);
      toast.success(t('settings:languages.defaultChanged', { name: row.name }));
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('common:messages.somethingWentWrong')));
    }
  }

  async function remove(row) {
    try {
      await languagesApi.remove(row.id);
      setConfirmRemove(null);
      toast.success(t('settings:languages.removed'));
      reload();
    } catch (e) {
      setConfirmRemove(null);
      toast.error(apiErrorMessage(e, t('settings:languages.defaultCannotBeDeleted')));
    }
  }

  const columns = useMemo(() => [
    {
      key: 'name', header: t('settings:languages.language'), sortKey: 'name',
      minWidth: 200, alwaysVisible: true,
      render: (r) => (
        <div>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          {r.is_default && (
            <span style={{ marginInlineStart: 8 }}>
              <StatusBadge tone="info" label={t('settings:languages.default')} />
            </span>
          )}
          {/* The native name renders in its own script and direction. */}
          <div className="muted" style={{ fontSize: 12.5 }}
            lang={r.code} dir={r.direction}>
            {r.native_name}
          </div>
        </div>
      ),
    },
    {
      key: 'code', header: t('settings:languages.code'), sortKey: 'code',
      minWidth: 110, nowrap: true,
      render: (r) => (
        <code className="ltr-text" style={{ fontSize: 12.5 }}>
          {r.code}{r.locale && r.locale !== r.code ? ` (${r.locale})` : ''}
        </code>
      ),
    },
    {
      key: 'direction', header: t('settings:languages.direction'),
      sortKey: 'direction', minWidth: 130, priority: 'medium',
      render: (r) => (
        <StatusBadge tone={r.is_rtl ? 'warning' : 'muted'}
          label={r.is_rtl ? t('settings:languages.rtl') : t('settings:languages.ltr')} />
      ),
    },
    {
      key: 'status', header: t('common:labels.status'), sortKey: 'is_enabled',
      minWidth: 110,
      render: (r) => (
        <StatusBadge tone={r.is_enabled ? 'success' : 'muted'}
          label={r.is_enabled ? t('common:state.enabled') : t('common:state.disabled')} />
      ),
    },
    {
      key: 'order', header: t('settings:languages.displayOrder'),
      sortKey: 'display_order', align: 'right', minWidth: 100,
      priority: 'low', render: (r) => r.display_order,
    },
  ], [t]);

  const filters = useMemo(() => [
    {
      key: 'is_enabled', label: t('common:labels.status'), type: 'boolean',
      trueLabel: t('common:state.enabled'), falseLabel: t('common:state.disabled'),
    },
    {
      key: 'direction', label: t('settings:languages.direction'), type: 'select',
      options: [
        { value: 'ltr', label: t('settings:languages.ltr') },
        { value: 'rtl', label: t('settings:languages.rtl') },
      ],
    },
  ], [t]);

  // Removal is offered only where it is safe; disabling is the reversible
  // action and the one we steer toward. The backend refuses either way.
  const rowActions = useCallback((row) => (canManage ? [
    { key: 'edit', label: t('common:actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditing({ ...row }) },
    !row.is_default && {
      key: 'default', label: t('settings:languages.makeDefault'), icon: <Star size={14} />,
      onClick: () => makeDefault(row) },
    {
      key: 'toggle',
      label: row.is_enabled ? t('common:actions.disable') : t('common:actions.enable'),
      icon: <Check size={14} />,
      disabled: row.is_default && row.is_enabled,
      onClick: () => languagesApi.update(row.id, { is_enabled: !row.is_enabled })
        .then(() => { toast.success(t('settings:languages.saved')); reload(); })
        .catch((e) => toast.error(apiErrorMessage(
          e, t('settings:languages.defaultCannotBeDisabled')))),
    },
    !row.is_default && {
      key: 'remove', label: t('common:actions.remove'), icon: <Trash2 size={14} />,
      danger: true, onClick: () => setConfirmRemove(row) },
  ].filter(Boolean) : []), [canManage, t, reload]);

  return (
    <ListPage
      title={t('settings:languages.title')}
      subtitle={t('settings:languages.subtitle')}
      actions={canManage && (
        <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}>
          <Plus size={15} /> {t('settings:languages.addLanguage')}
        </button>
      )}
    >
      <ListView
        tableKey="languages"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="display_order"
        searchPlaceholder={`${t('settings:languages.language')}, ${t('settings:languages.code')}`}
        emptyTitle={t('settings:languages.emptyTitle')}
        emptyHint={t('settings:languages.emptyHint')}
        columns={columns}
        filters={filters}
        groupOptions={groups(t)}
        rowActions={canManage ? rowActions : undefined}
      />

      <LanguageModal
        value={editing}
        busy={busy}
        onChange={setEditing}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        tone="danger"
        title={t('settings:languages.removeConfirmTitle')}
        confirmLabel={t('common:actions.remove')}
        message={confirmRemove ? (
          <>
            {t('settings:languages.removeConfirmBody', { name: confirmRemove.name })}
            <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
              {t('settings:languages.prefer')}
            </div>
          </>
        ) : null}
        onConfirm={() => remove(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
      />
    </ListPage>
  );
}

function LanguageModal({ value, busy, onChange, onClose, onSave }) {
  const { t } = useTranslation(['settings', 'common']);
  const { language } = useLanguage();
  if (!value) return null;

  const set = (key, v) => onChange({ ...value, [key]: v });

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={value.id
        ? t('settings:languages.editLanguage')
        : t('settings:languages.addLanguage')}
      size="md"
      footer={(
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={onSave}>
            {busy ? t('common:state.saving') : t('common:actions.save')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid form-grid--2">
          <FormField label={t('settings:languages.language')}>
            <input className="form-input" value={value.name}
              onChange={(e) => set('name', e.target.value)} />
          </FormField>
          <FormField label={t('settings:languages.nativeName')}>
            {/* Typed in the language itself, so the field follows its direction. */}
            <input className="form-input" value={value.native_name}
              dir={value.direction} lang={value.code || language}
              onChange={(e) => set('native_name', e.target.value)} />
          </FormField>
        </div>

        <div className="form-grid form-grid--2">
          <FormField label={t('settings:languages.code')}
            hint={t('settings:languages.codeHint')}>
            <input className="form-input ltr-text" value={value.code}
              onChange={(e) => set('code', e.target.value)} />
          </FormField>
          <FormField label={t('settings:languages.locale')}
            hint={t('settings:languages.localeHint')}>
            <input className="form-input ltr-text" value={value.locale}
              onChange={(e) => set('locale', e.target.value)} />
          </FormField>
        </div>

        <div className="form-grid form-grid--2">
          <FormField label={t('settings:languages.direction')}>
            <select className="form-input" value={value.direction}
              onChange={(e) => set('direction', e.target.value)}>
              <option value="ltr">{t('settings:languages.ltr')}</option>
              <option value="rtl">{t('settings:languages.rtl')}</option>
            </select>
          </FormField>
          <FormField label={t('settings:languages.displayOrder')}>
            <input className="form-input" type="number" min="0"
              value={value.display_order}
              onChange={(e) => set('display_order', e.target.value)} />
          </FormField>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', fontSize: 13.5 }}>
          <input type="checkbox" checked={value.is_enabled}
            disabled={value.is_default}
            onChange={(e) => set('is_enabled', e.target.checked)} />
          {t('settings:languages.enabled')}
        </label>
        {value.is_default && (
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {t('settings:languages.defaultCannotBeDisabled')}
          </p>
        )}
      </div>
    </Modal>
  );
}
