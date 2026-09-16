import { titleCase } from '../utils/titleCase.js';

export function FormField({ label, error, hint, children }) {
  return (
    <div className="form-group">
      {label && <label className="form-label">{titleCase(label)}</label>}
      {children}
      {error && <div className="form-error">{error}</div>}
      {!error && hint && <div className="form-help">{hint}</div>}
    </div>
  );
}
