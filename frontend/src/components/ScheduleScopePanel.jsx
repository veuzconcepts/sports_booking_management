import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EffectiveSchedule, ScheduleEditor, WeeklyTimeline } from './ScheduleEditor.jsx';
import { ScheduleImpactNotice } from './ScheduleImpactNotice.jsx';
import { scheduleApi } from '../services/scheduleService.js';
import { useTimeFormat } from '../services/timeformat.jsx';
import './schedule.css';

/**
 * The Club and Facility wrapper around `ScheduleEditor`: the inheritance
 * switch, the resolved "Effective Schedule" preview, and the warning about
 * bookings a narrower schedule would orphan.
 *
 * Inheritance is REAL, not a copy. "Use parent schedule" saves an empty
 * document, so the scope keeps following its parent and a later change to the
 * organization still reaches it. Switching to Customize starts from nothing and
 * overrides only the days actually edited.
 */
export function ScheduleScopePanel({
  scope,                 // 'club' | 'facility'
  parentLabel,           // 'Organization' | the club's name
  query,                 // {club: id} | {facility: id}; null for an unsaved row
  custom,
  onCustom,
  week,
  onWeek,
  slotMinutes,
  onSlotMinutes,
  bufferBefore,
  bufferAfter,
  onBuffers,
  canEdit = true,
}) {
  const { t } = useTranslation('schedule');
  const { format24 } = useTimeFormat();
  const [effective, setEffective] = useState(null);
  const [impact, setImpact] = useState(null);
  const [showEffective, setShowEffective] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // The parent's resolved week: what the greyed-out rows show while inheriting,
  // and what "Reset to parent" returns a day to.
  const load = useCallback(() => {
    if (!query) { setEffective(null); return; }
    scheduleApi.effective(query).then((d) => setEffective(d)).catch(() => setEffective(null));
    scheduleApi.impact(query).then((d) => setImpact(d)).catch(() => setImpact(null));
  }, [query && query.club, query && query.facility]);   // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const inherited = effective?.week || null;
  const overriddenDays = Object.keys(week || {}).length;

  return (
    <div className="sch" style={{ marginTop: 10 }}>
      <div className={`sch-source${custom ? ' sch-source--custom' : ''}`}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={!custom} disabled={!canEdit}
            onChange={(e) => onCustom(!e.target.checked)} />
          <span className="sch-source__text">
            {t('useParent', { parent: parentLabel })}
          </span>
        </label>
        <span className="sch-source__text muted" style={{ fontSize: 12.5 }}>
          {custom
            ? (overriddenDays
              ? t('daysCustomised', { count: overriddenDays, parent: parentLabel })
              : t('nothingCustomised', { parent: parentLabel }))
            : t('followsParent', { scope, parent: parentLabel })}
        </span>

        <div className="sch-bar__spacer" />
        {query && (
          <button type="button" className="btn btn-secondary"
            onClick={() => setShowEffective((v) => !v)}>
            {showEffective ? <EyeOff size={14} /> : <Eye size={14} />}
            {showEffective ? t('hideEffective') : t('effectiveSchedule')}
          </button>
        )}
      </div>

      <ScheduleImpactNotice impact={impact} />

      {custom && (
        <>
          <ScheduleEditor
            scope={scope}
            parentLabel={parentLabel}
            value={week}
            onChange={onWeek}
            inherited={inherited}
            slotMinutes={slotMinutes === '' ? null : slotMinutes}
            onSlotMinutes={(v) => onSlotMinutes(v ?? '')}
            bufferBefore={bufferBefore === '' ? null : bufferBefore}
            bufferAfter={bufferAfter === '' ? null : bufferAfter}
            onBuffers={(before, after) => onBuffers(before ?? '', after ?? '')}
            canEdit={canEdit}
            onResetAll={() => onWeek({})}
          />
          <div>
            <button type="button" className="btn btn-secondary"
              onClick={() => setShowTimeline((v) => !v)}>
              {showTimeline ? t('hideTimeline') : t('weeklyTimeline')}
            </button>
          </div>
          {showTimeline && inherited && (
            <WeeklyTimeline week={{ ...inherited, ...(week || {}) }} format24={format24} />
          )}
        </>
      )}

      {showEffective && inherited && (
        <div>
          <div className="sch-detail__title" style={{ marginBottom: 6 }}>
            {t('effectiveSchedule')}
          </div>
          <EffectiveSchedule week={inherited} format24={format24} />
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {t('effectiveHint')}
          </p>
        </div>
      )}
    </div>
  );
}
