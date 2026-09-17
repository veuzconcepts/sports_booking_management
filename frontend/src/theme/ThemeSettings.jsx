import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { ErrorState } from '../components/ErrorState.jsx';
import { FormField } from '../components/FormField.jsx';
import { Modal } from '../components/Modal.jsx';
import { Select2 } from '../components/Select2.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import { apiErrorMessage } from '../utils/apiError.js';
import { themeApi, themePresetsApi } from '../services/themeService.js';
import { ColorField } from './ColorField.jsx';
import { ThemePreview } from './ThemePreview.jsx';
import { useTheme } from './ThemeProvider.jsx';
import { contrastRatio, readableTextOn } from './tokens.js';
import './theme.css';

/**
 * Organization branding: the theme the whole application renders from.
 *
 * The draft lives here and only reaches the rest of the interface on save, so
 * an administrator can try a palette without changing what anyone else sees.
 * The token catalogue comes from the backend rather than being listed again
 * here, which is what keeps "what may be themed" a single answer.
 */
export function ThemeSettings() {
  const { t } = useTranslation('organization');
  const { hasPerm } = useAuth();
  const { reload: reloadAppTheme } = useTheme();
  const canEdit = hasPerm('organization.manage');

  const [config, setConfig] = useState(null);     // catalogue + defaults + saved
  const [draft, setDraft] = useState({});         // overrides being edited
  const [presetName, setPresetName] = useState('');
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmPreset, setConfirmPreset] = useState(null);   // preset to apply
  const [archiving, setArchiving] = useState(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [themeData, presetData] = await Promise.all([
        themeApi.get(),
        themePresetsApi.list(),
      ]);
      setConfig(themeData);
      setDraft(themeData.theme || {});
      setPresetName(themeData.preset_name || '');
      setPresets(Array.isArray(presetData) ? presetData : presetData?.results || []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const defaults = config?.defaults || {};
  const resolved = useMemo(() => ({ ...defaults, ...draft }), [defaults, draft]);

  // What the server holds, so the dirty state is a real comparison rather than
  // a flag someone has to remember to set.
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(config?.theme || {}),
    [draft, config],
  );

  const groups = useMemo(() => {
    const byGroup = new Map();
    (config?.catalogue || []).forEach((entry) => {
      if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
      byGroup.get(entry.group).push(entry);
    });
    return [...byGroup.entries()];
  }, [config]);

  /**
   * Scored locally so the warning keeps up with the picker. The backend runs
   * the same check on save and is what actually decides.
   */
  const contrast = useMemo(() => (config?.contrast || []).map((pair) => {
    const ratio = contrastRatio(resolved[pair.foreground], resolved[pair.background]);
    return {
      ...pair,
      ratio,
      passes: ratio >= pair.minimum,
      suggestion: readableTextOn(resolved[pair.background]),
    };
  }), [config, resolved]);

  const failing = contrast.filter((pair) => !pair.passes);

  function setToken(token, value) {
    setDraft((current) => {
      const next = { ...current };
      if (value === defaults[token]) delete next[token];
      else next[token] = value;
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const data = await themeApi.save(draft, presetName);
      setConfig((c) => ({ ...c, theme: data.theme, contrast: data.contrast }));
      setDraft(data.theme || {});
      await reloadAppTheme();
      toast.success(t('theme.saved'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('theme.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setConfirmReset(false);
    setSaving(true);
    try {
      const data = await themeApi.reset();
      setConfig((c) => ({ ...c, theme: {}, contrast: data.contrast }));
      setDraft({});
      setPresetName('');
      await reloadAppTheme();
      toast.success(t('theme.reset'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('theme.resetFailed')));
    } finally {
      setSaving(false);
    }
  }

  /** Load a preset into the draft. Nothing is saved until Save is pressed. */
  function usePreset(preset) {
    setConfirmPreset(null);
    setDraft(preset.tokens || {});
    setPresetName(preset.name);
    toast.success(t('theme.presetLoaded', { name: preset.name }));
  }

  async function saveAsPreset() {
    const name = newPresetName.trim();
    if (!name) { toast.error(t('theme.presetNameRequired')); return; }
    setSaving(true);
    try {
      const created = await themePresetsApi.create({ name, tokens: draft });
      setPresets((list) => [...list, created]);
      setPresetName(created.name);
      setSaveAsOpen(false);
      setNewPresetName('');
      toast.success(t('theme.presetSaved', { name: created.name }));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('theme.presetSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function duplicatePreset(preset) {
    try {
      const clone = await themePresetsApi.duplicate(preset.id);
      setPresets((list) => [...list, clone]);
      toast.success(t('theme.presetSaved', { name: clone.name }));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('theme.presetSaveFailed')));
    }
  }

  async function archivePreset(preset) {
    setArchiving(null);
    try {
      await themePresetsApi.remove(preset.id);
      setPresets((list) => list.filter((p) => p.id !== preset.id));
      toast.success(t('theme.presetArchived', { name: preset.name }));
    } catch (e) {
      toast.error(apiErrorMessage(e, t('theme.presetArchiveFailed')));
    }
  }

  if (loading) return <p className="muted">{t('common:state.loading')}</p>;
  if (error || !config) return <ErrorState onRetry={load} />;

  return (
    <>
      <div className="th-layout">
        <div>
          {/* ------------------------------------------------- presets --- */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('theme.presetsTitle')}</h3>
                <p className="card-subtitle">{t('theme.presetsHint')}</p>
              </div>
              {canEdit && (
                <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => { setNewPresetName(''); setSaveAsOpen(true); }}>
                  <Plus size={14} /> {t('theme.saveAsPreset')}
                </button>
              )}
            </div>
            <div className="card-body">
              <div className="th-presets">
                {presets.map((preset) => (
                  <div
                    key={preset.id}
                    className={`th-preset${preset.name === presetName ? ' is-active' : ''}`}
                  >
                    <div className="th-preset__head">
                      <span className="th-preset__name">{preset.name}</span>
                      {preset.is_builtin && (
                        <span className="th-preset__tag">{t('theme.builtIn')}</span>
                      )}
                    </div>
                    <div className="th-preset__swatches">
                      {['primary', 'headerBg', 'sidebarActiveBg', 'pageBg', 'accent'].map((token) => (
                        <span
                          key={token}
                          className="th-preset__swatch"
                          style={{ background: preset.resolved?.[token] }}
                        />
                      ))}
                    </div>
                    {canEdit && (
                      <div className="th-preset__actions">
                        <button
                          type="button" className="btn btn-secondary btn-sm"
                          onClick={() => (dirty ? setConfirmPreset(preset) : usePreset(preset))}
                        >
                          {t('theme.usePreset')}
                        </button>
                        <button type="button" className="icon-btn"
                          title={t('common:actions.duplicate')}
                          onClick={() => duplicatePreset(preset)}>
                          <Copy size={14} />
                        </button>
                        {!preset.is_builtin && (
                          <button type="button" className="icon-btn"
                            title={t('common:actions.archive')}
                            style={{ color: 'var(--color-danger-600)' }}
                            onClick={() => setArchiving(preset)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* -------------------------------------------------- colours --- */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('theme.coloursTitle')}</h3>
                <p className="card-subtitle">{t('theme.coloursHint')}</p>
              </div>
            </div>
            <div className="card-body">
              {groups.map(([group, entries]) => (
                <div className="th-group" key={group}>
                  <div className="th-group__title">
                    {config.groups?.[group] || group}
                  </div>
                  <div className="th-grid">
                    {entries.map((entry) => (
                      <ColorField
                        key={entry.token}
                        label={entry.label}
                        value={resolved[entry.token]}
                        defaultValue={entry.default}
                        disabled={!canEdit}
                        onChange={(value) => setToken(entry.token, value)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div className="th-group">
                <div className="th-group__title">{t('theme.shapeTitle')}</div>
                <FormField label={t('theme.cornerStyle')} hint={t('theme.cornerStyleHint')}>
                  <Select2
                    options={(config.corner_styles || []).map((value) => ({
                      value, label: t(`theme.corners.${value}`),
                    }))}
                    value={resolved.cornerStyle}
                    disabled={!canEdit}
                    onChange={(value) => setToken('cornerStyle', value)}
                  />
                </FormField>
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------ preview + contrast --- */}
        <aside className="th-aside">
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('theme.previewTitle')}</h3>
                <p className="card-subtitle">{t('theme.previewHint')}</p>
              </div>
            </div>
            <div className="card-body">
              <ThemePreview theme={resolved} />
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t('theme.contrastTitle')}</h3>
                <p className="card-subtitle">
                  {failing.length
                    ? t('theme.contrastFailing', { count: failing.length })
                    : t('theme.contrastAllPass')}
                </p>
              </div>
            </div>
            <div className="card-body">
              <div className="th-contrast">
                {contrast.map((pair) => (
                  <div
                    key={`${pair.foreground}-${pair.background}`}
                    className={`th-contrast__item${pair.passes ? '' : ' is-fail'}`}
                  >
                    {pair.passes
                      ? <Check size={14} className="th-contrast__ok" />
                      : <AlertTriangle size={14} />}
                    <span className="th-contrast__label">{pair.label}</span>
                    <span className="th-contrast__ratio">{pair.ratio.toFixed(2)}</span>
                    {!pair.passes && canEdit && (
                      <button
                        type="button" className="btn btn-secondary btn-sm"
                        onClick={() => setToken(pair.foreground, pair.suggestion)}
                      >
                        {t('theme.useSafeColour')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* The action bar appears only when there is something to act on. */}
      {canEdit && (dirty || Object.keys(draft).length > 0) && (
        <div className="th-bar">
          <span className="th-bar__text">
            {dirty ? t('theme.unsaved') : t('theme.customActive')}
          </span>
          <button type="button" className="btn btn-secondary" disabled={saving}
            onClick={() => setConfirmReset(true)}>
            <RotateCcw size={15} /> {t('theme.resetToDefault')}
          </button>
          <button type="button" className="btn btn-primary" disabled={saving || !dirty}
            onClick={save}>
            <Save size={15} /> {saving ? t('common:state.saving') : t('theme.saveAndApply')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        tone="danger"
        title={t('theme.resetTitle')}
        message={t('theme.resetBody')}
        confirmLabel={t('theme.resetToDefault')}
        onConfirm={reset}
        onClose={() => setConfirmReset(false)}
      />

      <ConfirmDialog
        open={Boolean(confirmPreset)}
        title={t('theme.usePresetTitle')}
        message={confirmPreset ? t('theme.usePresetBody', { name: confirmPreset.name }) : null}
        confirmLabel={t('theme.usePreset')}
        onConfirm={() => usePreset(confirmPreset)}
        onClose={() => setConfirmPreset(null)}
      />

      <ConfirmDialog
        open={Boolean(archiving)}
        tone="danger"
        title={t('theme.archivePresetTitle')}
        message={archiving ? t('theme.archivePresetBody', { name: archiving.name }) : null}
        confirmLabel={t('common:actions.archive')}
        onConfirm={() => archivePreset(archiving)}
        onClose={() => setArchiving(null)}
      />

      <Modal
        open={saveAsOpen}
        onClose={() => setSaveAsOpen(false)}
        title={t('theme.saveAsPreset')}
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" disabled={saving}
              onClick={() => setSaveAsOpen(false)}>{t('common:actions.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={saving}
              onClick={saveAsPreset}>{t('common:actions.save')}</button>
          </>
        )}
      >
        <FormField label={t('theme.presetName')} hint={t('theme.presetNameHint')}>
          <input
            className="form-input"
            autoFocus
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
          />
        </FormField>
      </Modal>
    </>
  );
}
