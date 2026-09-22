import { useMemo, useState } from 'react';
import { Calendar, Plus, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { RowMenu } from '../../components/listview/index.js';
import { NEXT_STATUSES } from '../../services/bookingsService.js';
import { formatDate } from '../../services/timeformat.jsx';
import { statusClass, statusLabel } from './bookingStatus.js';
import { ActivityThumb } from './ActivityThumb.jsx';

/**
 * Bookings as a board: one column per stage, a card per booking, and drag to
 * move a booking forward.
 *
 * The board is a VIEW of the same query the table and calendar use, so search,
 * filters and scope behave identically whichever view is open.
 *
 * Dragging does not decide anything. A column accepts a card only when the
 * booking's current status genuinely allows that transition, and the move is
 * then made by the backend, which is the authority on booking state. An
 * impossible drop is refused visibly rather than attempted and silently lost.
 */

/**
 * The columns, and which statuses land in each.
 *
 * Several statuses share a column where they mean the same thing to someone
 * working the board: an arrived customer and one mid-session are both "in
 * progress", and everything finished sits under "closed" with its own
 * breakdown. The status itself is never rewritten; this is grouping only.
 */
const COLUMNS = [
  { key: 'pending', labelKey: 'board.pending', target: 'booked', statuses: ['booked'] },
  { key: 'assigned', labelKey: 'board.assigned', target: 'assigned', statuses: ['assigned'] },
  { key: 'confirmed', labelKey: 'board.confirmed', target: 'confirmed', statuses: ['confirmed'] },
  {
    key: 'in_progress',
    labelKey: 'board.inProgress',
    target: 'in_progress',
    statuses: ['arrived', 'in_progress'],
  },
  {
    key: 'closed',
    labelKey: 'board.closed',
    target: null,                 // terminal: nothing is dragged into it
    statuses: ['completed', 'closed', 'cancelled', 'no_show'],
    breakdown: true,
  },
];

/** "Layla Ahmed" -> "LA". */
function personMark(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/** A short, unambiguous day label: the board has no room for a full date. */
function dayLabel(value) {
  const full = formatDate(value);
  return full || value || '';
}

function BookingBoardCard({
  row, onOpen, actions, onAssign, draggable, onDragStart, onDragEnd, dragging,
}) {
  const { t } = useTranslation('bookings');
  const live = row.status === 'in_progress';
  const cancelled = row.status === 'cancelled' || row.status === 'no_show';
  const unpaid = row.payment_status && row.payment_status !== 'paid';

  return (
    <article
      className={`bkb-card ${statusClass(row.status)}`
        + `${live ? ' bkb-card--live' : ''}`
        + `${cancelled ? ' bkb-card--void' : ''}`
        + `${dragging ? ' is-dragging' : ''}`}
      draggable={draggable}
      onDragStart={(e) => {
        // Without data attached, a drag never starts in Firefox and is treated
        // as invalid elsewhere. The id is what a drop would need anyway.
        try {
          e.dataTransfer.setData('text/plain', String(row.id));
          e.dataTransfer.effectAllowed = 'move';
        } catch { /* some browsers lock dataTransfer outside a real drag */ }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); }
      }}
      aria-label={t('card.aria', { reference: row.reference, status: statusLabel(row.status) })}
    >
      <header className="bkb-card__head">
        <span className="bkb-card__ref">{row.reference}</span>
        {live && <span className="bkb-card__live">{t('board.liveNow')}</span>}
        {actions && (
          <span className="bkb-card__menu" onClick={(e) => e.stopPropagation()}>
            <RowMenu actions={actions} />
          </span>
        )}
      </header>

      <div className="bkb-card__facility">
        <ActivityThumb
          src={row.facility_type_image}
          name={row.facility_type_name || row.facility_name}
          size={30}
        />
        <span className="bkb-card__names">
          <strong className="bkb-card__title">
            {row.facility_name || row.facility_type_name || t('title')}
          </strong>
          <span className="bkb-card__club">{row.club_name || t('card.noClub')}</span>
        </span>
      </div>

      <div className="bkb-card__meta">
        <Calendar size={13} aria-hidden="true" />
        <span>{dayLabel(row.scheduled_date)}</span>
        {row.source_display && <span className="bkb-card__dot">·</span>}
        {row.source_display && <span>{row.source_display}</span>}
        {unpaid && (
          <span className="bkb-card__pay">{t('board.payPending')}</span>
        )}
      </div>

      <footer className="bkb-card__foot">
        <span className="bkb-card__who">
          <span className="bkb-card__avatar" aria-hidden="true">
            {personMark(row.customer_label)}
          </span>
          <span className="bkb-card__person">{row.customer_label}</span>
        </span>
        {onAssign && (
          <button
            type="button"
            className="bkb-card__add"
            title={t('board.assignStaff')}
            aria-label={t('board.assignStaff')}
            onClick={(e) => { e.stopPropagation(); onAssign(row); }}
          >
            <UserPlus size={13} />
          </button>
        )}
      </footer>
    </article>
  );
}

/**
 * The board. Paging is deliberately absent: a board that only shows page one of
 * a stage is misleading about how much work is in it, so the page hands the
 * board a large enough window and the column counts are the truth.
 */
export function BookingCards({
  rows, loading, onOpen, onEdit, onDuplicate, onDelete, onNew, onAssign,
  onStatusChange, canEdit, canDuplicate, canDelete,
}) {
  const { t } = useTranslation('bookings');
  const { t: tc } = useTranslation('common');
  const [dragged, setDragged] = useState(null);      // the row being dragged
  const [over, setOver] = useState(null);            // column key under the cursor

  const byColumn = useMemo(() => {
    const map = new Map(COLUMNS.map((c) => [c.key, []]));
    rows.forEach((row) => {
      const column = COLUMNS.find((c) => c.statuses.includes(row.status));
      if (column) map.get(column.key).push(row);
    });
    return map;
  }, [rows]);

  /**
   * Whether a column would accept this card. The answer is the backend's
   * transition table, not a guess: a booking can only move where the booking
   * engine already allows it to move, and the server checks again on the write.
   */
  function accepts(column, row = dragged) {
    if (!row || !column.target || !onStatusChange) return false;
    if (column.statuses.includes(row.status)) return false;       // already there
    return (NEXT_STATUSES[row.status] || []).includes(column.target);
  }

  function drop(column) {
    const row = dragged;
    setOver(null);
    setDragged(null);
    // `row` is read before the state clears, so the check cannot depend on the
    // order React happens to apply those updates in.
    if (accepts(column, row)) onStatusChange(row, column.target);
  }

  function actionsFor(row) {
    const actions = [];
    // Dragging is a mouse gesture. The same moves belong in the menu so the
    // board can be worked with a keyboard, and so the available transitions
    // are discoverable rather than something you find by trying.
    if (onStatusChange) {
      (NEXT_STATUSES[row.status] || []).forEach((next) => {
        actions.push({
          key: `move-${next}`,
          label: t('board.moveTo', { status: statusLabel(next) }),
          onClick: () => onStatusChange(row, next),
        });
      });
    }
    if (canEdit && row.can_modify) {
      actions.push({ key: 'edit', label: t('actions.editBooking'), onClick: () => onEdit(row) });
    }
    if (canDuplicate) {
      actions.push({
        key: 'duplicate', label: t('actions.duplicateBooking'), onClick: () => onDuplicate(row),
      });
    }
    if (canDelete && row.can_delete) {
      actions.push({
        key: 'delete', label: t('actions.deleteBooking'), danger: true, onClick: () => onDelete(row),
      });
    }
    return actions.length ? actions : null;
  }

  if (loading && rows.length === 0) {
    return <div className="bk-cal__empty">{tc('state.loading')}</div>;
  }

  return (
    <div className="bkb">
      <div className="bkb__hint">
        <span aria-hidden="true">↔</span> {t('board.dragHint')}
      </div>

      <div className="bkb__columns">
        {COLUMNS.map((column) => {
          const cards = byColumn.get(column.key) || [];
          const open = accepts(column);
          const isOver = over === column.key && open;
          const first = column.statuses[0];

          return (
            <section
              key={column.key}
              className={`bkb-col${open ? ' is-open' : ''}${isOver ? ' is-over' : ''}`}
              onDragOver={(e) => {
                if (!open) return;
                // Both are required: preventDefault is what permits the drop at
                // all, and dropEffect is what stops the cursor showing the
                // "not allowed" sign over a column that will happily take it.
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOver(column.key);
              }}
              onDragLeave={() => setOver((k) => (k === column.key ? null : k))}
              onDrop={(e) => { e.preventDefault(); drop(column); }}
              aria-label={t(column.labelKey)}
            >
              <header className="bkb-col__head">
                <span className={`bkb-col__dot ${statusClass(first)}`} aria-hidden="true" />
                <h3 className="bkb-col__name">{t(column.labelKey)}</h3>
                <span className="bkb-col__count">{cards.length}</span>
                {onNew && (
                  <button type="button" className="bkb-col__add"
                    title={t('newBooking')} aria-label={t('newBooking')}
                    onClick={() => onNew(column.target)}>
                    <Plus size={14} />
                  </button>
                )}
              </header>

              <div className="bkb-col__body">
                {column.breakdown
                  ? column.statuses
                    .map((status) => ({ status, items: cards.filter((r) => r.status === status) }))
                    .filter((group) => group.items.length > 0)
                    .map((group) => (
                      <div className="bkb-col__group" key={group.status}>
                        <div className="bkb-col__group-head">
                          <span className={`bkb-col__dot ${statusClass(group.status)}`}
                            aria-hidden="true" />
                          <span>{statusLabel(group.status)}</span>
                          <span className="bkb-col__count">{group.items.length}</span>
                        </div>
                        {group.items.map((row) => (
                          <BookingBoardCard
                            key={row.id} row={row} onOpen={onOpen} onAssign={onAssign}
                            actions={actionsFor(row)}
                            draggable={Boolean(onStatusChange)}
                            dragging={dragged?.id === row.id}
                            onDragStart={() => setDragged(row)}
                            onDragEnd={() => { setDragged(null); setOver(null); }}
                          />
                        ))}
                      </div>
                    ))
                  : cards.map((row) => (
                    <BookingBoardCard
                      key={row.id} row={row} onOpen={onOpen} onAssign={onAssign}
                      actions={actionsFor(row)}
                      draggable={Boolean(onStatusChange)}
                      dragging={dragged?.id === row.id}
                      onDragStart={() => setDragged(row)}
                      onDragEnd={() => { setDragged(null); setOver(null); }}
                    />
                  ))}

                {/* An empty column that can take the dragged card says so,
                    rather than leaving the reader guessing where it may go. */}
                {cards.length === 0 && (
                  <div className={`bkb-col__drop${open ? ' is-open' : ''}`}>
                    {open ? t('board.dropHere') : t('board.columnEmpty')}
                  </div>
                )}
              </div>

              {onNew && (
                <button type="button" className="bkb-col__foot"
                  onClick={() => onNew(column.target)}>
                  <Plus size={13} /> {t('board.addBooking')}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
