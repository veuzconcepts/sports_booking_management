import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Copy, Pencil, Trash2, List, LayoutGrid, CalendarDays, Eye, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useTabParam } from '../../hooks/useTabParam.js';
import { useFilterOptions, asOptions } from '../../hooks/useFilterOptions.js';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  bookingSources,
  bookingStatuses,
  bookingsApi,
  bookingDuplicateInitial,
  bookingEditInitial,
} from '../../services/bookingsService.js';
import { BookingFormModal } from './BookingFormModal.jsx';
import { BookingCards } from './BookingCards.jsx';
import { BookingCalendar } from './BookingCalendar.jsx';
import './bookingViews.css';

import { Money } from '../../services/currency.jsx';
import { formatDate } from '../../services/timeformat.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import { exportRowsToCsv } from '../../utils/exportCsv.js';
import { ActivityThumb } from './ActivityThumb.jsx';

const VIEWS = [
  { key: 'list', labelKey: 'views.list', Icon: List },
  { key: 'cards', labelKey: 'views.cards', Icon: LayoutGrid },
  { key: 'calendar', labelKey: 'views.calendar', Icon: CalendarDays },
];


// Plain values for the CSV: a column that renders JSX must say what it exports.
// Built with `t` at export time, so the file a user downloads is headed in the
// language they are working in.
const exportColumns = (t) => [
  { key: 'reference', header: t('columns.reference') },
  { key: 'customer_label', header: t('columns.customer') },
  { key: 'club_name', header: t('columns.club') },
  { key: 'facility_type_name', header: t('columns.facilityType') },
  { key: 'facility_name', header: t('columns.facility') },
  { key: 'scheduled_date', header: t('columns.bookingDate') },
  { key: 'scheduled_time', header: t('columns.startTime') },
  { key: 'status', header: t('columns.status') },
  { key: 'payment_status', header: t('columns.payment') },
  { key: 'source', header: t('columns.source') },
  { key: 'assigned_to_name', header: t('columns.assigned') },
  { key: 'total_amount', header: t('columns.total') },
  { key: 'currency', header: t('columns.currency') },
];

const GROUP_KEYS = [
  ['club', 'groups.club'],
  ['facility', 'groups.facility'],
  ['facility_type', 'groups.facilityType'],
  ['status', 'groups.status'],
  ['payment_status', 'groups.paymentStatus'],
  ['source', 'groups.source'],
  ['customer', 'groups.customer'],
  ['assigned_to', 'groups.assignedTo'],
];

export default function BookingsListPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [formInitial, setFormInitial] = useState(null);   // duplicate prefill (null = blank create)
  const [editBooking, setEditBooking] = useState(null);   // row being edited (null = closed)
  const [deleteRow, setDeleteRow] = useState(null);       // row pending delete confirm
  const [deleteReasons, setDeleteReasons] = useState([]);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteNote, setDeleteNote] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  // The chosen view lives in the URL, so a refresh or a shared link keeps it.
  const [view, setView] = useTabParam('list', 'view');
  const { hasPerm } = useAuth();
  const canAdd = hasPerm('bookings.add');
  const canDuplicate = hasPerm('bookings.duplicate');
  const canEdit = hasPerm('bookings.edit');
  const canDelete = hasPerm('bookings.delete');
  const showActions = canDuplicate || canEdit || canDelete;
  const fetcher = useCallback((q) => bookingsApi.list(q), []);
  // Both the list and the calendar re-read on any change made on this page.
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const { t } = useTranslation('bookings');
  const { t: tc } = useTranslation('common');
  const { clubs, facilityTypes } = useFilterOptions();

  // Stable values, translated labels: the API keeps receiving 'confirmed'.
  const statusOptions = useMemo(
    () => bookingStatuses(t).map((o) => ({ value: o.value, label: t(`status.${o.value}`) })),
    [t],
  );
  const sourceOptions = useMemo(
    () => bookingSources(t).map((o) => ({ value: o.value, label: t(`source.${o.value}`) })),
    [t],
  );
  const canExport = hasPerm('reports.export');

  const openBooking = useCallback((row) => navigate(`/bookings/${row.id}`), [navigate]);
  const duplicateBooking = useCallback((row) => {
    setFormInitial(bookingDuplicateInitial(row));
    setModalOpen(true);
  }, []);

  /**
   * Move a booking to the next stage from the board.
   *
   * The transition endpoint owns the rules: this only asks, and reports what
   * the server says. A refused move leaves the card where it was, because the
   * board is redrawn from the reloaded list rather than from an optimistic
   * guess about what the server did.
   */
  const changeStatus = useCallback(async (row, status) => {
    try {
      await bookingsApi.transition(row.id, status);
      toast.success(t('actions.statusChanged', {
        reference: row.reference, status: t(`status.${status}`),
      }));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('actions.statusChangeFailed')));
    } finally {
      refresh();
    }
  }, [t]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  function openDelete(row) {
    setDeleteRow(row);
    setDeleteReason(''); setDeleteNote('');
    if (deleteReasons.length === 0) {
      bookingsApi.deletionReasons().then(setDeleteReasons).catch(() => setDeleteReasons([]));
    }
  }

  async function doDelete() {
    if (!deleteRow) return;
    if (!deleteReason) { toast.error(t('delete.reasonRequired')); return; }
    if (deleteReason.toLowerCase() === 'other' && !deleteNote.trim()) {
      toast.error(t('delete.noteRequired')); return;
    }
    setBusy(true);
    try {
      await bookingsApi.remove(deleteRow.id, { reason: deleteReason, reason_note: deleteNote.trim() });
      toast.success(t('actions.deleted'));
      setDeleteRow(null);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('delete.failed')));
    } finally {
      setBusy(false);
    }
  }

  // --- What this listing shows and how it can be narrowed -------------------
  // Only configuration: the shared ListView supplies the behaviour.
  const columns = useMemo(() => [
    {
      key: 'reference', header: t('reference'), sortKey: 'reference',
      minWidth: 150, alwaysVisible: true,
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* The activity at a glance. A listing of near-identical rows is
              read far faster by picture than by name. */}
          <ActivityThumb src={r.facility_type_image} name={r.facility_type_name} size={32} />
          <div style={{ minWidth: 0 }}>
            <span className="link-btn" style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>
              {r.reference}
            </span>
            <div className="muted" style={{ fontSize: 12 }}>
              {r.facility_type_name}
              {/* One of several slots bought together. Without this the list
                  reads as unrelated bookings that happen to share a customer. */}
              {r.order_reference ? ` · ${r.order_reference}` : ''}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'customer', header: t('columns.customer'), sortKey: 'customer__full_name',
      minWidth: 150, truncate: true,
      render: (r) => `${r.customer_label}${r.booking_type === 'walk_in' ? ' \u00b7 Walk-in' : ''}`,
    },
    { key: 'club', header: t('common:labels.club'), sortKey: 'club__name', minWidth: 130,
      truncate: true, render: (r) => r.club_name || '-' },
    { key: 'facility', header: t('common:labels.facility'), minWidth: 120, truncate: true,
      priority: 'medium',
      render: (r) => r.facility_name || <span className="muted">-</span> },
    { key: 'source', header: t('source'), sortKey: 'source', minWidth: 100,
      priority: 'low',
      render: (r) => r.source_display || (r.source ? r.source.replace('_', ' ') : '-') },
    { key: 'slot', header: t('bookingDate'), sortKey: 'scheduled_date', nowrap: true,
      minWidth: 120, render: (r) => formatDate(r.scheduled_date) },
    { key: 'assigned', header: t('columns.assigned'), sortKey: 'assigned_to__first_name',
      minWidth: 120, priority: 'low', truncate: true,
      render: (r) => r.assigned_to_name || <span className="muted">{t('common:state.unassigned')}</span> },
    { key: 'status', header: t('common:labels.status'), sortKey: 'status', minWidth: 110,
      render: (r) => <StatusBadge status={r.status} /> },
    { key: 'payment_status', header: t('columns.payment'), sortKey: 'payment_status',
      minWidth: 110, priority: 'medium',
      render: (r) => <StatusBadge status={r.payment_status} /> },
    { key: 'total', header: t('common:labels.total'), sortKey: 'total_amount', align: 'right',
      minWidth: 100, nowrap: true,
      render: (r) => <Money amount={r.total_amount} code={r.currency} /> },
  ], [t]);

  const filters = useMemo(() => [
    { key: 'status', label: t('filters.status'), type: 'select', options: statusOptions },
    { key: 'source', label: t('filters.source'), type: 'select', options: sourceOptions },
    { key: 'club', label: t('filters.club'), type: 'select', options: asOptions(clubs) },
    { key: 'facility_type', label: t('filters.facilityType'), type: 'select',
      options: asOptions(facilityTypes) },
    { key: 'payment_status', label: t('filters.paymentStatus'), type: 'select', options: [
      { value: 'pending', label: t('paymentStatus.pending') },
      { value: 'paid', label: t('paymentStatus.paid') },
      { value: 'partially_paid', label: t('paymentStatus.partially_paid') },
      { value: 'refunded', label: t('paymentStatus.refunded') },
    ] },
    { key: 'scheduled_date', label: t('filters.bookingDate'), type: 'date' },
  ], [clubs, facilityTypes, t]);

  // Row actions are filtered by permission AND by what the record allows, so
  // the menu never offers something the backend would refuse. The backend
  // remains the authority either way.
  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => openBooking(row) },
    canEdit && row.can_modify && {
      key: 'edit', label: tc('actions.edit'), icon: <Pencil size={14} />,
      onClick: () => setEditBooking(row) },
    canDuplicate && {
      key: 'duplicate', label: tc('actions.duplicate'), icon: <Copy size={14} />,
      onClick: () => duplicateBooking(row) },
    canDelete && row.can_delete && {
      key: 'delete', label: tc('actions.delete'), icon: <Trash2 size={14} />, danger: true,
      onClick: () => openDelete(row) },
  ].filter(Boolean), [canEdit, canDuplicate, canDelete, openBooking, duplicateBooking]);

  const groupOptions = useMemo(
    () => GROUP_KEYS.map(([key, labelKey]) => ({ key, label: t(labelKey) })), [t]);

  const bulkActions = useMemo(() => (canExport ? [{
    key: 'export',
    label: t('actions.exportSelected'),
    icon: <Download size={14} />,
    run: (ids, selected) => {
      exportRowsToCsv(selected, exportColumns(t), 'bookings');
      toast.success(t('actions.exported', { count: selected.length }));
    },
  }] : []), [canExport, t]);

  return (
    <ListPage
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        canAdd && (
          <button className="btn btn-primary" onClick={() => { setFormInitial(null); setModalOpen(true); }}>
            <Plus size={15} /> {t('newBooking')}
          </button>
        )
      }
    >
      <ListView
        tableKey="bookings"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-created_at"
        searchPlaceholder={t('searchPlaceholder')}
        emptyTitle={t('emptyTitle')}
        emptyHint={t('emptyHint')}
        onRowClick={openBooking}
        rowKey={(r) => r.id}
        columns={columns}
        filters={filters}
        groupOptions={groupOptions}
        rowActions={rowActions}
        bulkActions={bulkActions}
        toolbarRight={
          <div className="bk-views" role="group" aria-label={t('views.switcher')}>
            {VIEWS.map((v) => (
              <button key={v.key} className={view === v.key ? 'is-on' : ''}
                aria-pressed={view === v.key}
                title={t(v.labelKey)} onClick={() => setView(v.key)}>
                <v.Icon size={15} /> {t(v.labelKey)}
              </button>
            ))}
          </div>
        }
        renderBody={view === 'list' ? undefined : ({ rows, loading, count, page, pageSize, setPage, setPageSize, query }) => (
          <div className="lv-altbody">
          {view === 'cards' ? (
            <BookingCards
              rows={rows}
              loading={loading}
              onOpen={openBooking}
              onEdit={setEditBooking}
              onDuplicate={duplicateBooking}
              onDelete={openDelete}
              onNew={canAdd ? () => { setFormInitial(null); setModalOpen(true); } : undefined}
              onAssign={canEdit ? setEditBooking : undefined}
              onStatusChange={canEdit ? changeStatus : undefined}
              canEdit={canEdit}
              canDuplicate={canDuplicate}
              canDelete={canDelete}
            />
          ) : (
            <BookingCalendar
              filters={{ ...query.filters, search: query.search }}
              reloadKey={reloadKey}
              onOpen={openBooking}
              onReschedule={canEdit ? setEditBooking : undefined}
              onReviewInList={() => setView('list')}
            />
          )}
          </div>
        )}
      />

      <BookingFormModal
        open={modalOpen}
        initial={formInitial}
        onClose={() => { setModalOpen(false); setFormInitial(null); }}
        onSaved={(booking) => {
          setModalOpen(false); setFormInitial(null);
          toast.success(formInitial
            ? t('actions.duplicated', { reference: booking.reference })
            : t('actions.created', { reference: booking.reference }));
          refresh();
        }}
      />

      <BookingFormModal
        open={Boolean(editBooking)}
        editId={editBooking?.id}
        initial={editBooking ? bookingEditInitial(editBooking) : null}
        lockedExceptNotes={editBooking?.status === 'closed'}
        onClose={() => setEditBooking(null)}
        onSaved={() => { setEditBooking(null); toast.success(t('actions.updated')); refresh(); }}
      />

      <Modal
        open={Boolean(deleteRow)}
        onClose={() => { if (!busy) setDeleteRow(null); }}
        title={t('delete.title')}
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => setDeleteRow(null)}>{tc('actions.cancel')}</button>
            <button className="btn btn-danger" type="button" disabled={busy || !deleteReason}
              onClick={doDelete}>{busy ? tc('state.deleting') : t('delete.confirm')}</button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          {t('permanentlyDeleteBooking')} <strong>{deleteRow?.reference}</strong> and its history.
          This cannot be undone. A reason is required for the audit trail.
        </p>
        <FormField label={`${t('delete.reason')} *`}>
          <Select2
            options={deleteReasons.map((r) => ({ value: r, label: r }))}
            value={deleteReason}
            onChange={setDeleteReason}
            placeholder={t('delete.reasonPlaceholder')}
          />
        </FormField>
        <FormField label={`Note${deleteReason.toLowerCase() === 'other' ? ' *' : ' (optional)'}`}>
          <textarea className="form-textarea" rows={3} value={deleteNote}
            onChange={(e) => setDeleteNote(e.target.value)}
            placeholder={t('delete.notePlaceholder')} />
        </FormField>
      </Modal>
    </ListPage>
  );
}
