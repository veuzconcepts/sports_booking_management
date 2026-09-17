import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal.jsx';
import { FormField } from './FormField.jsx';

const PromptCtx = createContext(() => Promise.resolve(null));

/**
 * App-level styled replacement for window.prompt().
 *   const prompt = usePrompt();
 *   const v = await prompt({ title, label, defaultValue, type, multiline, hint, confirmLabel });
 * Resolves to the entered string, or null if cancelled.
 */
export function PromptProvider({ children }) {
  const { t } = useTranslation('common');
  const [opts, setOpts] = useState(null);
  const [value, setValue] = useState('');
  const resolver = useRef(null);

  const prompt = useCallback((options = {}) => {
    setValue(options.defaultValue != null ? String(options.defaultValue) : '');
    setOpts(options);
    return new Promise((resolve) => { resolver.current = resolve; });
  }, []);

  const finish = (result) => {
    setOpts(null);
    if (resolver.current) { resolver.current(result); resolver.current = null; }
  };

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      <Modal
        open={Boolean(opts)} size="sm"
        title={opts?.title || 'Enter a value'}
        onClose={() => finish(null)}
        footer={<>
          <button className="btn btn-secondary" type="button" onClick={() => finish(null)}>{t('common:actions.cancel')}</button>
          <button className="btn btn-primary" type="button" onClick={() => finish(value)}>
            {opts?.confirmLabel || 'OK'}
          </button>
        </>}
      >
        <FormField label={opts?.label} hint={opts?.hint}>
          {opts?.multiline ? (
            <textarea className="form-textarea" rows={3} autoFocus
              value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input
              className="form-input" type={opts?.type || 'text'} autoFocus
              value={value} onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(value); } }}
            />
          )}
        </FormField>
      </Modal>
    </PromptCtx.Provider>
  );
}

export function usePrompt() {
  return useContext(PromptCtx);
}
