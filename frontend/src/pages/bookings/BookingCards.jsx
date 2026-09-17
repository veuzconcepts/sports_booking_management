import { Calendar, Clock, MapPin, Copy, Pencil, Trash2, User } from 'lucide-react';

import { Pagination } from '../../components/DataTable.jsx';
import { Money } from '../../services/currency.jsx';
import { formatDate, formatTime, useTimeFormat } from '../../services/timeformat.jsx';
import { isInactive, statusClass, statusLabel } from './bookingStatus.js';

/** "Layla Ahmed" -> "LA"; falls back to a dash for an unassigned booking. */
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function slotLabel(row, format24) {
  const start = formatTime(row.scheduled_time, { format24 });
  if (!row.end_time) return start;
  return `${start} - ${formatTime(row.end_time, { format24 })}`;
}

/**
 * A booking as a card, in the spirit of a project board: status as a coloured
 * spine, the facility type as the headline, and the details that decide whether
 * you need to open it - when, where, who, how much.
 */
function BookingCard({ row, onOpen, actions }) {
  const { format24 } = useTimeFormat();
  const inactive = isInactive(row.status);
  const who = row.assigned_to_name || '';

  return (
    <article
      className={`bk-card ${statusClass(row.status)}${inactive ? ' bk-card--inactive' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); }
      }}
      aria-label={`Booking ${row.reference}, ${statusLabel(row.status)}`}
    >
      {actions ? <div className="bk-card__actions">{actions}</div> : null}

      <div className="bk-card__top">
        <span className="bk-card__ref">{row.reference}</span>
        <span className="bk-card__chip">{statusLabel(row.status)}</span>
      </div>

      <h3 className="bk-card__type">{row.facility_type_name || 'Booking'}</h3>
      <div className="bk-card__customer">
        {row.customer_label}{row.booking_type === 'walk_in' ? ' · Walk-in' : ''}
      </div>

      <div className="bk-card__meta">
        <div className="bk-card__row">
          <Calendar size={14} />
          <span>{formatDate(row.scheduled_date)}</span>
        </div>
        <div className="bk-card__row">
          <Clock size={14} />
          <span>{slotLabel(row, format24)}</span>
        </div>
        <div className="bk-card__row">
          <MapPin size={14} />
          <span>
            {row.club_name || 'No club'}
            {row.facility_name ? ` · ${row.facility_name}` : ''}
          </span>
        </div>
      </div>

      <div className="bk-card__foot">
        <div className="bk-card__who">
          <span className={`bk-card__avatar${who ? '' : ' bk-card__avatar--none'}`}>
            {who ? initials(who) : <User size={12} />}
          </span>
          <span>{who || 'Unassigned'}</span>
        </div>
        <span className="bk-card__total">
          <Money amount={row.total_amount} code={row.currency} />
        </span>
      </div>
    </article>
  );
}

/**
 * The card grid. Pages with the same control as the table view, so switching
 * between them keeps your place and behaves identically.
 */
export function BookingCards({
  rows, loading, count, page, pageSize, onPageChange,
  onOpen, onEdit, onDuplicate, onDelete,
  canEdit, canDuplicate, canDelete,
}) {
  if (loading && rows.length === 0) {
    return <div className="bk-cal__empty">Loading bookings…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="bk-cal__empty">
        <strong>No bookings yet</strong>
        <div style={{ marginTop: 4 }}>
          Create a booking, or wait for customers to book from the website.
        </div>
      </div>
    );
  }

  function actionsFor(row) {
    const buttons = [];
    if (canEdit && row.can_modify) {
      buttons.push(
        <button key="edit" className="icon-btn" title="Edit booking"
          onClick={(e) => { e.stopPropagation(); onEdit(row); }}>
          <Pencil size={14} />
        </button>,
      );
    }
    if (canDuplicate) {
      buttons.push(
        <button key="dup" className="icon-btn" title="Duplicate booking"
          onClick={(e) => { e.stopPropagation(); onDuplicate(row); }}>
          <Copy size={14} />
        </button>,
      );
    }
    if (canDelete && row.can_delete) {
      buttons.push(
        <button key="del" className="icon-btn" title="Delete booking"
          style={{ color: 'var(--color-danger-600)' }}
          onClick={(e) => { e.stopPropagation(); onDelete(row); }}>
          <Trash2 size={14} />
        </button>,
      );
    }
    return buttons.length ? buttons : null;
  }

  return (
    <>
      <div className="bk-cards">
        {rows.map((row) => (
          <BookingCard key={row.id} row={row} onOpen={onOpen} actions={actionsFor(row)} />
        ))}
      </div>

      <Pagination page={page} pageSize={pageSize} count={count}
        onPageChange={onPageChange} rowsShown={rows.length} />
    </>
  );
}
