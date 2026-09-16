import { Search } from 'lucide-react';

import { Select2 } from './Select2.jsx';

/**
 * Search + filter row above a DataTable.
 *
 * Props:
 *  - searchValue, onSearchChange, searchPlaceholder
 *  - filters: [{ value, options: [{ value, label }], onChange, placeholder }]
 *  - right:   any node (usually action buttons)
 */
export function Toolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  filters = [],
  right,
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        marginBottom: 12,
      }}
    >
      <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 360 }}>
        <Search
          size={16}
          style={{
            position: 'absolute', left: 12, top: '50%',
            transform: 'translateY(-50%)', color: 'var(--color-text-muted)',
          }}
        />
        <input
          className="form-input"
          style={{ paddingLeft: 36 }}
          value={searchValue || ''}
          placeholder={searchPlaceholder}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {filters.map((f, i) => (
        <div key={i} style={{ width: 200 }}>
          <Select2
            options={f.options}
            value={f.value || ''}
            onChange={(v) => f.onChange(v || null)}
            placeholder={f.placeholder || 'All'}
            clearable
          />
        </div>
      ))}

      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
