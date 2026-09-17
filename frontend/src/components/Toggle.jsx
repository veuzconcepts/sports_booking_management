import { forwardRef } from 'react';

import { titleCase } from '../utils/titleCase.js';

/**
 * Enterprise-style switch that plugs straight into react-hook-form's
 * `register('field')` (it forwards the ref and checkbox props).
 *
 *   <Toggle label="Active" description="…" {...register('is_active')} />
 */
export const Toggle = forwardRef(function Toggle(
  { label, description, ...inputProps }, ref,
) {
  return (
    <label className="switch-row form-group">
      <span className="switch-meta">
        <span className="switch-label">{titleCase(label)}</span>
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <span className="switch">
        <input type="checkbox" ref={ref} {...inputProps} />
        <span className="switch-track"><span className="switch-thumb" /></span>
      </span>
    </label>
  );
});
