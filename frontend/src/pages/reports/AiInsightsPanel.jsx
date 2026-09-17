import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, FileSpreadsheet, FileText, Maximize2, RefreshCw, Send, Sparkles,
  Trash2, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { apiErrorMessage } from '../../utils/apiError.js';
import { insightsApi } from '../../services/insightsService.js';
import { InsightWidgets } from './InsightWidgets.jsx';

/**
 * The AI Insights side panel.
 *
 * Deliberately not a modal: it slides in beside the Reports page and leaves it
 * visible and usable, because the point is to read the report while asking
 * about it. There is no scrim and no scroll lock, which is what separates this
 * from the Drawer used for record detail.
 *
 * The panel never computes anything. Numbers, charts and tables all arrive
 * already resolved from the backend; this renders them and carries the
 * conversation.
 */

const SESSION_KEY = 'ai_insights_session';

/** One session id per browser, so a refresh keeps the thread. */
function sessionId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return 'default';          // private mode: the thread lasts this page view
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The period and scope an answer covers, from the report metadata.
 *
 * Shown on every answer so a narrowed report is obvious: "17 Sep 2026, all
 * clubs" reads very differently from "19 Aug to 17 Sep 2026".
 */
function coverage(turn) {
  const meta = (turn.meta || []).find((entry) => entry?.date_from && entry?.date_to);
  if (!meta) return '';
  const when = meta.date_from === meta.date_to
    ? meta.date_from
    : `${meta.date_from} to ${meta.date_to}`;
  return [when, meta.scope].filter(Boolean).join(' | ');
}

export function AiInsightsPanel({ open, onClose, onOpenFullReport, scope }) {
  const { t } = useTranslation('reports');
  const [capabilities, setCapabilities] = useState(null);
  const [turns, setTurns] = useState([]);       // { question, answer, ... }
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState('');
  const session = useRef(sessionId());
  const thread = useRef(null);

  useEffect(() => {
    if (!open || capabilities) return;
    insightsApi.capabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities({ enabled: false, suggestions: [], catalogue: [] }));
  }, [open, capabilities]);

  // Keep the newest answer in view as the thread grows.
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [turns, busy]);

  const send = useCallback(async (text, { refresh = false } = {}) => {
    const asked = (text || '').trim();
    if (!asked || busy) return;
    setQuestion('');
    setBusy(true);
    // The question appears immediately; the answer fills in beside it.
    setTurns((current) => [...current, { question: asked, pending: true }]);
    try {
      const result = await insightsApi.ask(asked, session.current, { refresh });
      setTurns((current) => current.map((turn, index) => (
        index === current.length - 1 ? { question: asked, ...result } : turn
      )));
    } catch (e) {
      const message = apiErrorMessage(e, t('insights.unavailable'));
      setTurns((current) => current.map((turn, index) => (
        index === current.length - 1 ? { question: asked, error: message } : turn
      )));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  async function download(reportId, fmt) {
    setExporting(`${reportId}:${fmt}`);
    try {
      const blob = await insightsApi.download(reportId, fmt);
      downloadBlob(blob, `insights-report.${fmt}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, t('insights.exportFailed')));
    } finally {
      setExporting('');
    }
  }

  async function startOver() {
    await insightsApi.clear(session.current).catch(() => {});
    setTurns([]);
  }

  if (!open) return null;

  const unavailable = capabilities && capabilities.enabled === false;

  return (
    <aside className="ai-panel" aria-label={t('insights.title')}>
      <header className="ai-panel__head">
        <div>
          <h2 className="ai-panel__title">
            <Sparkles size={16} /> {t('insights.title')}
          </h2>
          <p className="ai-panel__subtitle">{t('insights.subtitle')}</p>
        </div>
        <div className="ai-panel__head-actions">
          {turns.length > 0 && (
            <button type="button" className="icon-btn" title={t('insights.newConversation')}
              onClick={startOver}>
              <Trash2 size={15} />
            </button>
          )}
          <button type="button" className="icon-btn" title={t('common:actions.close')}
            onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>

      {/* What the answers will cover, taken from the report's own filters so
          the two can never describe different periods. Read-only: the filters
          above the report remain the one place scope is changed. */}
      {scope && (
        <div className="ai-scope">
          <span className="ai-scope__k">{t('insights.scope')}</span>
          <span className="ai-scope__v">{scope.period}</span>
          <span className="ai-scope__v">{scope.club}</span>
          <span className="ai-scope__sync">{t('insights.syncedWithFilters')}</span>
        </div>
      )}

      <div className="ai-panel__thread" ref={thread}>
        {unavailable && (
          <div className="ai-note ai-note--warn">{t('insights.unavailable')}</div>
        )}

        {!turns.length && !unavailable && (
          <div className="ai-empty">
            <p className="ai-empty__lead">{t('insights.emptyLead')}</p>
            {(capabilities?.suggestions || []).length > 0 && (
              <p className="ai-tryasking">{t('insights.tryAsking')}</p>
            )}
            <div className="ai-suggestions">
              {(capabilities?.suggestions || []).map((prompt) => (
                <button type="button" className="ai-suggestion" key={prompt}
                  onClick={() => send(prompt)}>
                  {/* The prompt's own first letter. A cue to tell one row
                      from the next at a glance, not a category: inventing
                      categories here would be labelling data we do not have. */}
                  <span className="ai-suggestion__key" aria-hidden="true">
                    {prompt.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="ai-suggestion__text">{prompt}</span>
                  <ArrowRight size={14} className="ai-suggestion__go" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) => (
          // The thread is append-only, so the position is a stable key.
          // eslint-disable-next-line react/no-array-index-key
          <div className="ai-turn" key={index}>
            <div className="ai-bubble ai-bubble--user">{turn.question}</div>

            {turn.pending && (
              <div className="ai-bubble ai-bubble--ai ai-bubble--pending">
                {t('insights.thinking')}
              </div>
            )}

            {turn.error && (
              <div className="ai-note ai-note--warn">{turn.error}</div>
            )}

            {turn.answer && (
              <div className="ai-bubble ai-bubble--ai">
                <p className="ai-answer">{turn.answer}</p>

                <InsightWidgets widgets={turn.widgets} compact />

                <div className="ai-turn__meta">
                  {/* What was measured, not just when. An answer that narrowed
                      to one day or one club must say so. */}
                  {coverage(turn) && (
                    <span className="ai-turn__coverage">{coverage(turn)}</span>
                  )}
                  {/* Freshness is stated rather than implied: a reused answer
                      and a newly queried one look the same otherwise. */}
                  <span>
                    {turn.cached ? t('insights.reused') : t('insights.freshlyGenerated')}
                  </span>
                </div>

                <div className="ai-turn__actions">
                  {turn.widgets?.length > 0 && onOpenFullReport && (
                    <button type="button" className="btn btn-secondary btn-sm"
                      onClick={() => onOpenFullReport(turn)}>
                      <Maximize2 size={13} /> {t('insights.openFullReport')}
                    </button>
                  )}
                  {turn.export_supported && turn.report_id && (
                    <>
                      <button type="button" className="btn btn-secondary btn-sm"
                        disabled={exporting === `${turn.report_id}:xlsx`}
                        onClick={() => download(turn.report_id, 'xlsx')}>
                        <FileSpreadsheet size={13} /> {t('excel')}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm"
                        disabled={exporting === `${turn.report_id}:pdf`}
                        onClick={() => download(turn.report_id, 'pdf')}>
                        <FileText size={13} /> PDF
                      </button>
                    </>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm"
                    title={t('insights.refreshHint')}
                    onClick={() => send(turn.question, { refresh: true })}>
                    <RefreshCw size={13} /> {t('insights.refresh')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="ai-panel__composer"
        onSubmit={(e) => { e.preventDefault(); send(question); }}
      >
        <input
          className="form-input"
          value={question}
          disabled={busy || unavailable}
          placeholder={t('insights.placeholder')}
          aria-label={t('insights.placeholder')}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn btn-primary"
          disabled={busy || unavailable || !question.trim()}
          aria-label={t('insights.send')}>
          <Send size={15} />
        </button>
      </form>
    </aside>
  );
}
