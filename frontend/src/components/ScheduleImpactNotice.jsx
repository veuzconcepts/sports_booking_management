import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * "This change no longer covers N existing bookings."
 *
 * One notice for every schedule surface: the weekly editor, the special-date
 * form and the special-date removal dialog all render this, so the wording of
 * a warning about someone's booking cannot drift between screens.
 *
 * It only ever reports. Moving or cancelling a booking stays a separate,
 * permissioned action taken deliberately by a person.
 */
/**
 * Why the booking no longer fits, as the backend reports it, mapped onto
 * translation keys. The stable identifier stays the API's; only the label is
 * localized.
 */
const REASON_KEYS = {
  closed: 'impact.reason.closed',
  break: 'impact.reason.break',
  'outside hours': 'impact.reason.outsideHours',
};

export function ScheduleImpactNotice({ impact, limit = 5 }) {
  const { t } = useTranslation('schedule');
  if (!impact || !impact.count) return null;

  const shown = (impact.bookings || []).slice(0, limit);
  return (
    <div className="sch-impact">
      <AlertTriangle size={16} />
      <span>{t('impact.warning', { count: impact.count })}</span>
      <ul className="sch-impact__list">
        {shown.map((booking) => (
          <li key={booking.id}>
            {booking.reference} - {booking.date} {booking.time}
            {booking.facility ? ` - ${booking.facility}` : ''}
            {' '}({REASON_KEYS[booking.reason]
              ? t(REASON_KEYS[booking.reason])
              : booking.reason})
          </li>
        ))}
        {impact.count > shown.length && (
          <li>{t('impact.andMore', { count: impact.count - shown.length })}</li>
        )}
      </ul>
    </div>
  );
}
