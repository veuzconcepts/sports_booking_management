/**
 * Export rows the user has selected to a CSV file.
 *
 * Client-side on purpose: these rows are already on screen, so exporting a
 * selection needs no extra request and no server round trip. Exporting a WHOLE
 * filtered dataset is a different job and belongs on the reports endpoints,
 * which already stream xlsx and pdf.
 */
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ is treated as a formula by spreadsheet software;
  // prefixing breaks that without changing what the reader sees.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * `columns` are [{key, header, exportValue?}]. `exportValue(row)` lets a column
 * that renders JSX give a plain value instead; otherwise the raw field is used,
 * never the rendered markup.
 */
export function exportRowsToCsv(rows, columns, filename = 'export') {
  const usable = columns.filter((c) => c.exportable !== false);
  const header = usable.map((c) => cell(
    typeof c.header === 'string' ? c.header : c.key));

  const body = rows.map((row) => usable.map((c) => cell(
    c.exportValue ? c.exportValue(row) : row[c.key],
  )));

  // The BOM keeps non-ASCII names readable when Excel opens the file.
  const csv = `﻿${[header, ...body].map((r) => r.join(',')).join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
