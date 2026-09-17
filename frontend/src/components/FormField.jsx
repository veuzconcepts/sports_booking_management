import { Children, cloneElement, isValidElement, useId } from 'react';

import { titleCase } from '../utils/titleCase.js';

/**
 * Label, control, and the error or hint that belongs to it.
 *
 * The label is genuinely associated with the control rather than merely sitting
 * above it: clicking it focuses the field, and a screen reader announces the
 * two together. The id is generated here and pushed onto the single element
 * child, so callers keep writing `<FormField label="Name"><input /></FormField>`
 * and get the association for free. A child that already carries its own `id`
 * or `aria-label` is left exactly as it is.
 */
export function FormField({ label, error, hint, children }) {
  const generatedId = useId();
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  const controllable = isValidElement(only)
    && typeof only.type === 'string'            // a real input/select/textarea
    && !only.props.id
    && !only.props['aria-label'];

  const controlId = controllable ? generatedId : undefined;
  const describedBy = error || hint ? `${generatedId}-note` : undefined;

  const control = controllable
    ? cloneElement(only, {
      id: controlId,
      'aria-describedby': only.props['aria-describedby'] || describedBy,
      ...(error ? { 'aria-invalid': true } : {}),
    })
    : children;

  return (
    <div className="form-group">
      {label && (
        <label className="form-label" htmlFor={controlId}>{titleCase(label)}</label>
      )}
      {control}
      {error && <div className="form-error" id={describedBy}>{error}</div>}
      {!error && hint && <div className="form-help" id={describedBy}>{hint}</div>}
    </div>
  );
}
