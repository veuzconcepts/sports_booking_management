import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Copy, Pencil, Trash2, List, LayoutGrid, CalendarDays } from 'lucide-react';
import toast from 'react-hot-toast';

import { PageHeader } from '../../components/PageHeader.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toolbar } from '../../components/Toolbar.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { FormField } from '../../components/FormField.jsx';
import { Select2 } from '../../components/Select2.jsx';
import { useApiList } from '../../hooks/useApiList.js';
import { useTabParam } from '../../hooks/useTabParam.js';
import { useAuth } from '../../hooks/useAuth.jsx';

import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
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

const VIEWS = [
  { key: 'list',     label: 'List',     Icon: List },
  { key: 'cards',    label: 'Cards',    Icon: LayoutGrid },
  { key: 'calendar', label: 'Calendar', Icon: CalendarDays },
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
  const canDuplicate = hasPerm('bookings.duplicate');
  const canEdit = hasPerm('bookings.edit');
  const canDelete = hasPerm('bookings.delete');
  const showActions = canDuplicate || canEdit || canDelete;
  const fetcher = useCallback((q) => bookingsApi.list(q), []);
  const { rows, loading, count, query, setQuery, reload } = useApiList(fetcher, {
    ordering: '-created_at',   // Newest created first.
  });
  const onSort = (o) => setQuery({ ...query, ordering: o, page: 1 });
  // The calendar loads its own date range, so it needs telling when a
  // booking is created, edited or deleted elsewhere on the page.
  const [calendarKey, setCalendarKey] = useState(0);
  const refresh = useCallback(() => { reload(); setCalendarKey((k) => k + 1); }, [reload]);

  const openBooking = useCallback((row) => navigate(`/bookings/${row.id}`), [navigate]);
  const duplicateBooking = useCallback((row) => {
    setFormInitial(bookingDuplicateInitial(row));
    setModalOpen(true);
  }, []);

  function openDelete(row) {
    setDeleteRow(row);
    setDeleteReason(''); setDeleteNote('');
    if (deleteReasons.length === 0) {
      bookingsApi.deletionReasons().then(setDeleteReasons).catch(() => setDeleteReasons([]));
    }
  }

  async function doDelete() {
    if (!deleteRow) return;
    if (!deleteReason) { toast.error('Select a reason for deleting this booking.'); return; }
    if (deleteReason.toLowerCase() === 'other' && !deleteNote.trim()) {
      toast.error('Describe the reason when choosing “Other”.'); return;
    }
    setBusy(true);
    try {
      await bookingsApi.remove(deleteRow.id, { reason: deleteReason, reason_note: deleteNote.trim() });
      toast.success('Booking deleted successfully.');
      setDeleteRow(null);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Unable to delete the booking. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle="Every facility booking across your clubs."
        actions={
          hasPerm('bookings.add') && (
            <button className="btn btn-primary" onClick={() => { setFormInitial(null); setModalOpen(true); }}>
              <Plus size={15} /> New booking
            </button>
          )
        }
      />

      <Toolbar
        right={
          <div className="bk-views" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.key} className={view === v.key ? 'is-on' : ''}
                aria-pressed={view === v.key}
                title={v.label} onClick={() => setView(v.key)}>
                <v.Icon size={15} /> {v.label}
              </button>
            ))}
          </div>
        }
        searchValue={query.search}
        onSearchChange={(v) => setQuery({ ...query, search: v || undefined, page: 1 })}
        searchPlaceholder="Reference, customer, facility…"
        filters={[
          {
            value: query.status,
            options: BOOKING_STATUSES,
            placeholder: 'All statuses',
            onChange: (v) => setQuery({ ...query, status: v, page: 1 }),
          },
          {
            value: query.source,
            options: BOOKING_SOURCES,
            placeholder: 'All sources',
            onChange: (v) => setQuery({ ...query, source: v, page: 1 }),
          },
        ]}
      />

      {view === 'list' && (
      <DataTable
        loading={loading}
        rows={rows}
        ordering={query.ordering}
        onSort={onSort}
        page={query.page || 1}
        count={count}
        onPageChange={(p) => setQuery({ ...query, page: p })}
        onRowClick={(r) => navigate(`/bookings/${r.id}`)}
        emptyTitle="No bookings yet"
        emptyHint="Create a booking, or wait for customers to book from the website."
        columns={[
          {
            key: 'reference', header: 'Reference', sortKey: 'reference',
            render: (r) => (
              <div>
                <button className="link-btn" style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}
                  onClick={(e) => { e.stopPropagation(); navigate(`/bookings/${r.id}`); }}>
                  {r.reference}
                </button>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.facility_type_name}
                </div>
              </div>
            ),
          },
          {
            key: 'customer', header: 'Customer', sortKey: 'customer__full_name',
            render: (r) => (
              <div>{r.customer_label}{r.booking_type === 'walk_in' ? ' · Walk-in' : ''}</div>
            ),
          },
          { key: 'club', header: 'Club', sortKey: 'club__name', render: (r) => r.club_name || '-' },
          { key: 'facility', header: 'Facility',
            render: (r) => r.facility_name || <span className="muted">-</span> },
          { key: 'source', header: 'Source', sortKey: 'source',
            render: (r) => r.source_display || (r.source ? r.source.replace('_', ' ') : '-') },
          { key: 'slot', header: 'Booking date', sortKey: 'scheduled_date', nowrap: true,
            render: (r) => formatDate(r.scheduled_date) },
          { key: 'assigned', header: 'Assigned', sortKey: 'assigned_to__first_name',
            render: (r) => r.assigned_to_name || <span className="muted">Unassigned</span> },
          { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'payment_status', header: 'Payment', sortKey: 'payment_status',
            render: (r) => <StatusBadge status={r.payment_status} /> },
          {
            key: 'total', header: 'Total', sortKey: 'total_amount', align: 'right',
            render: (r) => <Money amount={r.total_amount} code={r.currency} />,
          },
          ...(showActions ? [{
            key: 'actions', header: '', sticky: 'right', render: (r) => (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                {canEdit && r.can_modify && (
                  <button className="icon-btn" title="Edit booking"
                    onClick={(e) => { e.stopPropagation(); setEditBooking(r); }}>
                    <Pencil size={15} />
                  </button>
                )}
                {canDuplicate && (
                  <button className="icon-btn" title="Duplicate booking"
                    onClick={(e) => { e.stopPropagation(); setFormInitial(bookingDuplicateInitial(r)); setModalOpen(true); }}>
                    <Copy size={15} />
                  </button>
                )}
                {canDelete && r.can_delete && (
                  <button className="icon-btn" title="Delete booking" style={{ color: 'var(--color-danger, #dc2626)' }}
                    onClick={(e) => { e.stopPropagation(); openDelete(r); }}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ),
          }] : []),
        ]}
      />
      )}

      {view === 'cards' && (
        <BookingCards
          rows={rows}
          loading={loading}
          count={count}
          page={query.page || 1}
          pageSize={query.page_size || 20}
          onPageChange={(p) => setQuery({ ...query, page: p })}
          onOpen={openBooking}
          onEdit={setEditBooking}
          onDuplicate={duplicateBooking}
          onDelete={openDelete}
          canEdit={canEdit}
          canDuplicate={canDuplicate}
          canDelete={canDelete}
        />
      )}

      {view === 'calendar' && (
        <BookingCalendar
          filters={query}
          reloadKey={calendarKey}
          onOpen={openBooking}
        />
      )}

      <BookingFormModal
        open={modalOpen}
        initial={formInitial}
        onClose={() => { setModalOpen(false); setFormInitial(null); }}
        onSaved={(booking) => {
          setModalOpen(false); setFormInitial(null);
          toast.success(formInitial ? `Booking ${booking.reference} duplicated` : `Booking ${booking.reference} created`);
          refresh();
        }}
      />

      <BookingFormModal
        open={Boolean(editBooking)}
        editId={editBooking?.id}
        initial={editBooking ? bookingEditInitial(editBooking) : null}
        lockedExceptNotes={editBooking?.status === 'closed'}
        onClose={() => setEditBooking(null)}
        onSaved={() => { setEditBooking(null); toast.success('Booking updated successfully.'); refresh(); }}
      />

      <Modal
        open={Boolean(deleteRow)}
        onClose={() => { if (!busy) setDeleteRow(null); }}
        title="Delete booking"
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => setDeleteRow(null)}>Cancel</button>
            <button className="btn btn-danger" type="button" disabled={busy || !deleteReason}
              onClick={doDelete}>{busy ? 'Deleting…' : 'Delete booking'}</button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          Permanently delete booking <strong>{deleteRow?.reference}</strong> and its history.
          This cannot be undone. A reason is required for the audit trail.
        </p>
        <FormField label="Reason *">
          <Select2
            options={deleteReasons.map((r) => ({ value: r, label: r }))}
            value={deleteReason}
            onChange={setDeleteReason}
            placeholder="Select a reason…"
          />
        </FormField>
        <FormField label={`Note${deleteReason.toLowerCase() === 'other' ? ' *' : ' (optional)'}`}>
          <textarea className="form-textarea" rows={3} value={deleteNote}
            onChange={(e) => setDeleteNote(e.target.value)}
            placeholder="Add any detail for the record…" />
        </FormField>
      </Modal>
    </>
  );
}
