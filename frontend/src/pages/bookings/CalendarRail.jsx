import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { statusClass, statusLabel } from './bookingStatus.js';

/**
 * The calendar's side rail: a month to jump by, what is on the grid, and what
 * needs a person's attention.
 *
 * Everything here is derived from the bookings already loaded for the visible
 * range. It issues no queries of its own, so the counts can never disagree with
 * the grid beside them.
 */

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  + `-${String(d.getDate()).padStart(2, '0')}`;

/** Monday-first cells for a month, padded so the grid is a clean 7 wide. */
function monthCells(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;                 // Monday = 0
  const days = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d += 1) {
    cells.push(new Date(anchor.getFullYear(), anchor.getMonth(), d));
  }
  return cells;
}

export function CalendarRail({
  anchor, onAnchor, rows, days, today,
  statuses, hiddenStatuses, onToggleStatus,
  clubs, hiddenClubs, onToggleClub,
  onReviewInList,
}) {
  const { t } = useTranslation('bookings');

  const byDate = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => map.set(r.scheduled_date, (map.get(r.scheduled_date) || 0) + 1));
    return map;
  }, [rows]);

  const inView = useMemo(() => new Set(days.map(iso)), [days]);

  /**
   * What a manager should look at before the week starts. Each line is a real
   * gap in the data, not a guess: no confirmation yet, nothing paid, nobody
   * assigned.
   */
  const attention = useMemo(() => {
    const live = rows.filter((r) => !['cancelled', 'no_show'].includes(r.status));
    return [
      { key: 'unconfirmed', count: live.filter((r) => r.status === 'booked').length },
      {
        key: 'unpaid',
        count: live.filter((r) => r.payment_status && r.payment_status !== 'paid').length,
      },
      { key: 'unassigned', count: live.filter((r) => !r.assigned_to_name).length },
    ].filter((line) => line.count > 0);
  }, [rows]);

  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <aside className="bk-rail" aria-label={t('calendar.rail')}>
      <section className="bk-rail__card">
        <header className="bk-rail__month">
          <span className="bk-rail__month-name">{monthLabel}</span>
          <span className="bk-rail__month-nav">
            <button type="button" className="icon-btn" aria-label={t('calendar.previous')}
              onClick={() => onAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>
              <ChevronLeft size={14} />
            </button>
            <button type="button" className="icon-btn" aria-label={t('calendar.next')}
              onClick={() => onAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>
              <ChevronRight size={14} />
            </button>
          </span>
        </header>

        <div className="bk-rail__dow" aria-hidden="true">
          {DOW.map((d, i) => <span key={`${d}${i}`}>{d}</span>)}
        </div>

        <div className="bk-rail__grid">
          {monthCells(anchor).map((day, i) => {
            if (!day) return <span key={`pad-${i}`} className="bk-rail__pad" />;
            const key = iso(day);
            const selected = inView.has(key);
            const isToday = key === iso(today);
            return (
              <button
                key={key}
                type="button"
                className={`bk-rail__day${selected ? ' is-in-view' : ''}`
                  + `${isToday ? ' is-today' : ''}`}
                aria-pressed={selected}
                onClick={() => onAnchor(day)}
              >
                {day.getDate()}
                {byDate.get(key) ? <span className="bk-rail__pip" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </section>

      {statuses.length > 0 && (
        <section className="bk-rail__card">
          <h4 className="bk-rail__title">{t('calendar.status')}</h4>
          <ul className="bk-rail__list">
            {statuses.map((entry) => (
              <li key={entry.status}>
                <label className="bk-rail__check">
                  <input
                    type="checkbox"
                    checked={!hiddenStatuses.includes(entry.status)}
                    onChange={() => onToggleStatus(entry.status)}
                  />
                  <span className={`bk-rail__swatch ${statusClass(entry.status)}`}
                    aria-hidden="true" />
                  <span className="bk-rail__label">{statusLabel(entry.status)}</span>
                  <span className="bk-rail__count">{entry.count}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {clubs.length > 1 && (
        <section className="bk-rail__card">
          <h4 className="bk-rail__title">{t('calendar.clubs')}</h4>
          <ul className="bk-rail__list">
            {clubs.map((club) => (
              <li key={club.name}>
                <label className="bk-rail__check">
                  <input
                    type="checkbox"
                    checked={!hiddenClubs.includes(club.name)}
                    onChange={() => onToggleClub(club.name)}
                  />
                  <span className="bk-rail__label">{club.name}</span>
                  <span className="bk-rail__count">{club.count}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attention.length > 0 && (
        <section className="bk-rail__card bk-rail__card--attention">
          <h4 className="bk-rail__title">{t('calendar.needsAttention')}</h4>
          <ul className="bk-rail__list">
            {attention.map((line) => (
              <li key={line.key} className="bk-rail__attn">
                <span>{t(`calendar.attention.${line.key}`)}</span>
                <span className="bk-rail__count">{line.count}</span>
              </li>
            ))}
          </ul>
          {onReviewInList && (
            <button type="button" className="bk-rail__review" onClick={onReviewInList}>
              {t('calendar.reviewInList')}
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
