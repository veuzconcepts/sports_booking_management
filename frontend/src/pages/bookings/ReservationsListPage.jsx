import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, ExternalLink, RefreshCw, Unlock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { ListPage, ListView } from '../../components/listview/index.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useAuth } from '../../hooks/useAuth.jsx';
import { useFilterOptions, asOptions } from '../../hooks/useFilterOptions.js';

import {
  bookingSources, holdStatuses, reservationsApi,
} from '../../services/bookingsService.js';
import { formatDate, formatDateTime, formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { apiErrorMessage } from '../../utils/apiError';
import { HoldCountdown } from './HoldCountdown.jsx';
import { ReservationPanel } from './ReservationPanel.jsx';

/**
 * Reservations, for the people who have to explain them.
 *
 * A reservation leaves no booking row, so a held court shows on the day view
 * as a slot that simply will not take a booking, with nothing on the screen to
 * say why. This is where that question gets an answer: who is holding it, how
 * much longer they have, and whether it is worth waiting.
 *
 * It is a READ-ONLY screen with one exception. Releasing gives the courts back
 * before the deadline, for the reservation that is plainly stuck: the customer
 * rang off, the tab is closed, and the court is sitting idle until a clock
 * nobody is watching runs out.
 */

/** The first court and time, plus how many more the reservation holds. */
export function slotSummary(slots = [], { format24 = false } = {}) {
  if (!slots.length) return null;
  const [first] = slots;
  return {
    date: first.scheduled_date,
    time: formatTime(first.scheduled_time, { format24 }),
    facility: first.facility_name || '',
    extra: slots.length - 1,
  };
}

export default function ReservationsListPage() {
  const [detailRow, setDetailRow] = useState(null);
  const [releaseRow, setReleaseRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const navigate = useNavigate();
  const { hasPerm } = useAuth();
  const { format24 } = useTimeFormat();
  const { t } = useTranslation('bookings');
  const { t: tc } = useTranslation('common');
  const { clubs, facilityTypes } = useFilterOptions();

  // Viewing is gated by `bookings.view` (the route and the API both check it);
  // letting a court go early is an edit, so it asks for `bookings.edit`. The
  // backend enforces both regardless of what this offers.
  const canRelease = hasPerm('bookings.edit');
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  /**
   * Stamp each row with the moment its figures arrived.
   *
   * `seconds_remaining` is the server's own answer, and the countdown counts
   * down from it rather than comparing `expires_at` against this machine's
   * clock. A reception PC running twenty minutes fast would otherwise show
   * live reservations as expired, and staff would tell customers their court
   * had gone when it had not.
   */
  const fetcher = useCallback(async (params) => {
    const page = await reservationsApi.list(params);
    const receivedAt = Date.now();
    const stamp = (row) => ({ ...row, received_at: receivedAt });
    if (Array.isArray(page)) return page.map(stamp);
    return { ...page, results: (page?.results || []).map(stamp) };
  }, []);

  const statusOptions = useMemo(() => holdStatuses(t), [t]);
  const sourceOptions = useMemo(() => bookingSources(t), [t]);
  const sourceLabel = useCallback(
    (code) => sourceOptions.find((o) => o.value === code)?.label || code || '-',
    [sourceOptions]);

  const openBooking = useCallback((row) => {
    if (row.booking) navigate(`/bookings/${row.booking}`);
  }, [navigate]);

  async function doRelease() {
    if (!releaseRow) return;
    setBusy(true);
    try {
      await reservationsApi.release(releaseRow.id);
      toast.success(t('reservations.released', { reference: releaseRow.reference }));
      setReleaseRow(null);
      setDetailRow(null);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, t('reservations.releaseFailed')));
    } finally {
      setBusy(false);
    }
  }

  // --- What this listing shows and how it can be narrowed -------------------
  const columns = useMemo(() => [
    {
      key: 'reference', header: t('reference'), sortKey: 'reference',
      minWidth: 170, alwaysVisible: true,
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <span className="link-btn"
            style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>
            {r.reference}
          </span>
          <div className="muted" style={{ fontSize: 12 }}>
            {r.customer_name || t('reservations.guest')}
          </div>
        </div>
      ),
    },
    {
      key: 'status', header: tc('labels.status'), sortKey: 'status', minWidth: 110,
      // A row that is ACTIVE but past its deadline is not holding anything:
      // the sweep simply has not reached it yet. `is_live` asks the clock, so
      // the pill matches what the court is actually doing.
      render: (r) => <StatusBadge status={r.status} tone={r.is_live ? 'success' : undefined} />,
    },
    {
      key: 'time_left', header: t('reservations.columns.timeLeft'),
      sortKey: 'expires_at', minWidth: 100, nowrap: true,
      render: (r) => (
        <HoldCountdown secondsRemaining={r.seconds_remaining}
          receivedAt={r.received_at} live={r.is_live} />
      ),
    },
    {
      key: 'club', header: tc('labels.club'), minWidth: 130, truncate: true,
      render: (r) => r.club_name || '-',
    },
    {
      key: 'facility_type', header: t('columns.facilityType'), minWidth: 130,
      truncate: true, render: (r) => r.facility_type_name || <span className="muted">-</span>,
    },
    {
      key: 'slots', header: t('reservations.columns.courts'), minWidth: 190,
      priority: 'medium',
      render: (r) => {
        const summary = slotSummary(r.slots, { format24 });
        if (!summary) return <span className="muted">-</span>;
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              {formatDate(summary.date)} · {summary.time}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {summary.facility}
              {summary.extra > 0 ? ` · ${t('reservations.moreCourts', { n: summary.extra })}` : ''}
            </div>
          </div>
        );
      },
    },
    {
      key: 'source', header: t('source'), sortKey: 'source', minWidth: 100,
      priority: 'low', render: (r) => sourceLabel(r.source),
    },
    {
      key: 'created', header: t('reservations.columns.created'), sortKey: 'created_at',
      minWidth: 150, priority: 'low', nowrap: true,
      render: (r) => formatDateTime(r.created_at),
    },
    {
      key: 'outcome', header: t('reservations.columns.outcome'), minWidth: 140,
      priority: 'low',
      render: (r) => (r.booking_reference || r.order_reference
        ? (
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5 }}>
            {r.booking_reference || r.order_reference}
          </span>
        )
        : <span className="muted">-</span>),
    },
  ], [t, tc, format24, sourceLabel]);

  const filters = useMemo(() => [
    // "Live" asks the CLOCK, not the status, which is the distinction the whole
    // screen turns on. It is the default, because a list that opens on every
    // reservation ever taken buries the handful holding a court right now.
    {
      key: 'live', label: t('reservations.filters.live'), type: 'select',
      options: [
        { value: 'true', label: t('reservations.liveOnly') },
        { value: 'false', label: t('reservations.endedOnly') },
      ],
    },
    { key: 'status', label: t('filters.status'), type: 'select', options: statusOptions },
    { key: 'club', label: t('filters.club'), type: 'select', options: asOptions(clubs) },
    { key: 'facility_type', label: t('filters.facilityType'), type: 'select',
      options: asOptions(facilityTypes) },
    { key: 'source', label: t('filters.source'), type: 'select', options: sourceOptions },
  ], [t, statusOptions, sourceOptions, clubs, facilityTypes]);

  const rowActions = useCallback((row) => [
    { key: 'view', label: tc('actions.view'), icon: <Eye size={14} />,
      onClick: () => setDetailRow(row) },
    row.booking && {
      key: 'booking', label: t('reservations.openBooking'),
      icon: <ExternalLink size={14} />, onClick: () => openBooking(row) },
    // Only a live reservation is holding a court, so only a live one has
    // anything to give back. An ended one is history.
    canRelease && row.is_live && {
      key: 'release', label: t('reservations.release'), icon: <Unlock size={14} />,
      danger: true, onClick: () => setReleaseRow(row) },
  ].filter(Boolean), [canRelease, openBooking, t, tc]);

  return (
    <ListPage title={t('reservations.title')} subtitle={t('reservations.subtitle')}>
      <ListView
        tableKey="reservations"
        fetcher={fetcher}
        reloadKey={reloadKey}
        defaultOrdering="-created_at"
        defaultFilters={{ live: 'true' }}
        searchPlaceholder={t('reservations.searchPlaceholder')}
        emptyTitle={t('reservations.emptyTitle')}
        emptyHint={t('reservations.emptyHint')}
        onRowClick={setDetailRow}
        columns={columns}
        filters={filters}
        rowActions={rowActions}
        toolbarRight={
          // Countdowns tick on their own, but whether a reservation is still
          // live, and whether new ones have been taken, only changes when the
          // list is re-read.
          <button className="btn btn-secondary" type="button" onClick={refresh}>
            <RefreshCw size={15} /> {tc('actions.refresh')}
          </button>
        }
      />

      <ReservationPanel
        row={detailRow}
        open={Boolean(detailRow)}
        onClose={() => setDetailRow(null)}
        onRelease={setReleaseRow}
        releasing={busy}
        canRelease={canRelease}
      />

      <Modal
        open={Boolean(releaseRow)}
        onClose={() => { if (!busy) setReleaseRow(null); }}
        title={t('reservations.releaseTitle')}
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => setReleaseRow(null)}>{tc('actions.cancel')}</button>
            <button className="btn btn-danger" type="button" disabled={busy}
              onClick={doRelease}>
              {busy ? t('reservations.releasing') : t('reservations.release')}
            </button>
          </>
        }
      >
        {/* Releasing puts the court back on sale immediately, and the customer
            still holding the checkout tab is refused at the Pay button. That
            is the right outcome for an abandoned reservation and the wrong one
            for somebody mid-payment, so it is worth one deliberate click. */}
        <p style={{ marginTop: 0, fontSize: 13.5 }}>
          {t('reservations.releaseWarning', {
            reference: releaseRow?.reference || '',
            n: releaseRow?.slots?.length || 0,
          })}
        </p>
      </Modal>
    </ListPage>
  );
}
