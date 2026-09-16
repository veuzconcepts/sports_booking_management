import { Fragment } from 'react';

import { StatusBadge } from './StatusBadge.jsx';

/**
 * Grouped, column-aligned permission matrix (Salesforce-style).
 *
 *   sections:     [{ section, features:[{ key, label, basic:{read,create,edit,delete}, advanced:[{code,label}], codes:[] }] }]
 *   basicColumns: [{ key, label }]  (Read / Create / Edit / Delete)
 *   value:        Set of selected permission codes
 *   onChange(nextSet)
 *   readOnly:     render disabled
 *   baseline:     optional Set (role defaults) - shows +/- override badges (user-edit)
 */
export function PermissionMatrix({ sections = [], basicColumns = [], dataAdminColumns = [], value, onChange, readOnly = false, baseline }) {
  const cols = basicColumns.length ? basicColumns
    : [{ key: 'read', label: 'Read' }, { key: 'create', label: 'Create' },
       { key: 'edit', label: 'Edit' }, { key: 'delete', label: 'Delete' }];
  const dcols = dataAdminColumns.length ? dataAdminColumns
    : [{ key: 'view_all', label: 'View All' }, { key: 'modify_all', label: 'Modify All' }];
  const spanCols = cols.length + dcols.length + 2;

  const has = (code) => value.has(code);
  function setCodes(codes, on) {
    if (readOnly) return;
    const next = new Set(value);
    codes.forEach((c) => c && (on ? next.add(c) : next.delete(c)));
    onChange(next);
  }
  const toggle = (code) => setCodes([code], !has(code));

  function Badge({ code }) {
    if (!baseline || !code) return null;
    const sel = has(code);
    if (sel === baseline.has(code)) return null;     // matches the role default
    return <StatusBadge tone={sel ? 'success' : 'danger'} label={sel ? '+' : '−'} />;
  }

  function Box({ code }) {
    if (!code) return <span className="muted">-</span>;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={has(code)} disabled={readOnly} onChange={() => toggle(code)} />
        <Badge code={code} />
      </span>
    );
  }

  return (
    <div className="card">
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th rowSpan={2} style={{ minWidth: 170 }}>Feature</th>
              <th colSpan={cols.length} style={{ textAlign: 'center', background: 'rgba(124,58,237,0.06)' }}>
                Basic Access
              </th>
              <th colSpan={dcols.length} style={{ textAlign: 'center', background: 'rgba(2,132,199,0.08)' }}>
                Data Administration
              </th>
              <th rowSpan={2}>Advanced</th>
            </tr>
            <tr>
              {cols.map((c) => (
                <th key={c.key} style={{ textAlign: 'center', width: 74 }}>{c.label}</th>
              ))}
              {dcols.map((c) => (
                <th key={c.key} style={{ textAlign: 'center', width: 88 }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((sec) => {
              const codes = sec.features.flatMap((f) => f.codes);
              const allOn = codes.length > 0 && codes.every((c) => has(c));
              return (
                <Fragment key={sec.section}>
                  <tr>
                    <td colSpan={spanCols}
                        style={{ background: 'var(--color-surface-2, #f3f4f6)', fontWeight: 700, fontSize: 12.5 }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: readOnly ? 'default' : 'pointer' }}>
                        {!readOnly && (
                          <input type="checkbox" checked={allOn}
                                 onChange={(e) => setCodes(codes, e.target.checked)} />
                        )}
                        {sec.section}
                      </label>
                    </td>
                  </tr>
                  {sec.features.map((f) => (
                    <tr key={f.key}>
                      <td style={{ fontWeight: 600 }}>{f.label}</td>
                      {cols.map((c) => (
                        <td key={c.key} style={{ textAlign: 'center' }}><Box code={f.basic[c.key]} /></td>
                      ))}
                      {dcols.map((c) => (
                        <td key={c.key} style={{ textAlign: 'center' }}><Box code={f.data_admin?.[c.key]} /></td>
                      ))}
                      <td>
                        {f.advanced.length === 0 ? <span className="muted">-</span> : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                            {f.advanced.map((a) => (
                              <label key={a.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                                <input type="checkbox" checked={has(a.code)} disabled={readOnly} onChange={() => toggle(a.code)} />
                                {a.label}<Badge code={a.code} />
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
