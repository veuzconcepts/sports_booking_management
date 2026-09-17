import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ListView } from './ListView.jsx';
import { ListTable } from './ListTable.jsx';
import { prefsKey } from './useTablePrefs.js';
import { exportRowsToCsv } from '../../utils/exportCsv.js';

const COLUMNS = [
  { key: 'name', header: 'Name', sortKey: 'name', alwaysVisible: true },
  { key: 'club', header: 'Club', sortKey: 'club__name' },
  { key: 'status', header: 'Status', sortKey: 'status' },
  { key: 'total', header: 'Total', sortKey: 'total', align: 'right' },
];

const FILTERS = [
  { key: 'status', label: 'Status', type: 'select', options: [
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'booked', label: 'Pending' },
  ] },
  { key: 'club', label: 'Club', type: 'select', options: [
    { value: '1', label: 'Riverside Club' },
  ] },
  { key: 'date', label: 'Booking date', type: 'dateRange' },
];

const GROUPS = [
  { key: 'club', label: 'Club' },
  { key: 'status', label: 'Status' },
];

const ROWS = [
  { id: 1, name: 'BK-001', club: 'Riverside Club', status: 'confirmed', total: '100.00' },
  { id: 2, name: 'BK-002', club: 'Northside', status: 'booked', total: '50.00' },
];

let fetcher;

function renderList(props = {}) {
  return render(
    <MemoryRouter initialEntries={[props.route || '/list']}>
      <ListView
        tableKey={props.tableKey ?? 'test-table'}
        fetcher={fetcher}
        columns={COLUMNS}
        filters={FILTERS}
        groupOptions={GROUPS}
        defaultOrdering="-created_at"
        {...props}
      />
    </MemoryRouter>,
  );
}

/** Params of the most recent fetch. */
const lastParams = () => fetcher.mock.calls[fetcher.mock.calls.length - 1][0];

/** A column header button. Scoped to <thead>, because the same label also
 *  appears in the Group By and Columns menus. */
const header = (name) => within(document.querySelector('thead'))
  .getByRole('button', { name });
const headerCell = (name) => header(name).closest('th');
const queryHeader = (name) => within(document.querySelector('thead'))
  .queryByRole('button', { name });

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  fetcher = vi.fn(() => Promise.resolve({ results: ROWS, count: 2 }));
});

// --------------------------------------------------------------------------- //
describe('rendering and states', () => {
  it('renders the rows it is given', async () => {
    renderList();
    expect(await screen.findByText('BK-001')).toBeTruthy();
    expect(screen.getByText('BK-002')).toBeTruthy();
  });

  it('shows a loading state before the first response', () => {
    fetcher = vi.fn(() => new Promise(() => {}));     // never resolves
    renderList();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(document.querySelectorAll('.lt-skeleton').length).toBeGreaterThan(0);
  });

  it('shows an empty state when there is nothing to list', async () => {
    fetcher = vi.fn(() => Promise.resolve({ results: [], count: 0 }));
    renderList({ emptyTitle: 'No bookings yet' });
    expect(await screen.findByText('No bookings yet')).toBeTruthy();
  });

  it('distinguishes "no results" from "nothing exists"', async () => {
    fetcher = vi.fn(() => Promise.resolve({ results: [], count: 0 }));
    renderList({ route: '/list?search=zzz', emptyTitle: 'No bookings yet' });
    expect(await screen.findByText('No matching records')).toBeTruthy();
    expect(screen.queryByText('No bookings yet')).toBeNull();
  });

  it('shows an error with a retry rather than a blank table', async () => {
    fetcher = vi.fn(() => Promise.reject(new Error('network down')));
    renderList();
    expect(await screen.findByText('Could not load this list')).toBeTruthy();

    const before = fetcher.mock.calls.length;
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
  });
});

// --------------------------------------------------------------------------- //
describe('sorting', () => {
  it('first click sorts ascending', async () => {
    renderList();
    await screen.findByText('BK-001');
    fireEvent.click(header('Name'));
    await waitFor(() => expect(lastParams().ordering).toBe('name'));
  });

  it('second click sorts descending', async () => {
    renderList();
    await screen.findByText('BK-001');
    const nameHeader = header('Name');
    fireEvent.click(nameHeader);
    await waitFor(() => expect(lastParams().ordering).toBe('name'));
    fireEvent.click(nameHeader);
    await waitFor(() => expect(lastParams().ordering).toBe('-name'));
  });

  it('third click returns to the default order', async () => {
    renderList();
    await screen.findByText('BK-001');
    const nameHeader = header('Name');
    fireEvent.click(nameHeader);
    fireEvent.click(nameHeader);
    await waitFor(() => expect(lastParams().ordering).toBe('-name'));
    fireEvent.click(header('Name'));
    await waitFor(() => expect(lastParams().ordering).toBe('-created_at'));
  });

  it('marks the sorted column for assistive technology', async () => {
    renderList({ route: '/list?ordering=name' });
    await screen.findByText('BK-001');
    const th = headerCell('Name');
    expect(th.getAttribute('aria-sort')).toBe('ascending');
  });

  it('sorting happens on the server, not in the browser', async () => {
    renderList();
    await screen.findByText('BK-001');
    fireEvent.click(header('Club'));
    await waitFor(() => expect(lastParams().ordering).toBe('club__name'));
  });
});

// --------------------------------------------------------------------------- //
describe('search', () => {
  it('is debounced into a single request', async () => {
    vi.useFakeTimers();
    renderList();
    const box = screen.getByRole('searchbox');
    const before = fetcher.mock.calls.length;

    'booking'.split('').forEach((ch, i) => {
      fireEvent.change(box, { target: { value: 'booking'.slice(0, i + 1) } });
    });
    expect(fetcher.mock.calls.length).toBe(before);   // nothing yet

    vi.advanceTimersByTime(400);
    vi.useRealTimers();
    await waitFor(() => expect(lastParams().search).toBe('booking'));
    expect(fetcher.mock.calls.length).toBe(before + 1);
  });

  it('can be cleared', async () => {
    renderList({ route: '/list?search=abc' });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Clear search'));
    await waitFor(() => expect(lastParams().search).toBeUndefined());
  });
});

// --------------------------------------------------------------------------- //
describe('filters', () => {
  const openFilters = () => fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

  it('applies a single filter', async () => {
    renderList();
    await screen.findByText('BK-001');
    openFilters();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'confirmed' } });
    await waitFor(() => expect(lastParams().status).toBe('confirmed'));
  });

  it('combines several filters', async () => {
    renderList();
    await screen.findByText('BK-001');
    openFilters();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'confirmed' } });
    fireEvent.change(screen.getByLabelText('Club'), { target: { value: '1' } });
    await waitFor(() => {
      expect(lastParams().status).toBe('confirmed');
      expect(lastParams().club).toBe('1');
    });
  });

  it('shows an active filter as a removable chip', async () => {
    renderList({ route: '/list?status=confirmed' });
    await screen.findByText('BK-001');
    const chip = screen.getByText(/Status: Confirmed/);
    fireEvent.click(chip);
    await waitFor(() => expect(lastParams().status).toBeUndefined());
  });

  it('clears everything at once', async () => {
    renderList({ route: '/list?status=confirmed&club=1' });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByText('Clear all'));
    await waitFor(() => {
      expect(lastParams().status).toBeUndefined();
      expect(lastParams().club).toBeUndefined();
    });
  });

  it('sends a date range as one parameter', async () => {
    renderList();
    await screen.findByText('BK-001');
    openFilters();
    fireEvent.change(screen.getByLabelText('Booking date from'),
                     { target: { value: '2026-09-01' } });
    await waitFor(() => expect(lastParams().date).toBe('2026-09-01..'));
  });

  it('resets to the first page when a filter changes', async () => {
    renderList({ route: '/list?page=3' });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'booked' } });
    await waitFor(() => expect(lastParams().page).toBe(1));
  });
});

// --------------------------------------------------------------------------- //
describe('grouping', () => {
  beforeEach(() => {
    fetcher = vi.fn((params) => Promise.resolve(
      params.group_by
        ? { group_by: params.group_by, filter_param: 'club',
            groups: [{ key: 1, label: 'Riverside Club', count: 2 }] }
        : { results: ROWS, count: 2 },
    ));
  });

  it('asks the backend for groups rather than grouping locally', async () => {
    renderList();
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByRole('button', { name: /Group By/ }));
    fireEvent.click(within(document.querySelector('.lv-drop__pop')).getByText('Club'));
    await waitFor(() => expect(lastParams().group_by).toBe('club'));
  });

  it('shows each group with its count', async () => {
    renderList({ route: '/list?group_by=club' });
    expect(await screen.findByText('Riverside Club')).toBeTruthy();
    expect(screen.getByText('(2)')).toBeTruthy();
  });

  it('fetches a group\'s rows only when it is expanded', async () => {
    renderList({ route: '/list?group_by=club' });
    await screen.findByText('Riverside Club');
    expect(screen.queryByText('BK-001')).toBeNull();

    fireEvent.click(screen.getByText('Riverside Club'));
    await waitFor(() => expect(screen.getByText('BK-001')).toBeTruthy());
    expect(lastParams().club).toBe('1');
  });

  it('collapses again', async () => {
    renderList({ route: '/list?group_by=club' });
    const groupHead = () => document.querySelector('.lt-group__head');
    await waitFor(() => expect(groupHead()).toBeTruthy());

    fireEvent.click(groupHead());
    await waitFor(() => expect(screen.getByText('BK-001')).toBeTruthy());
    fireEvent.click(groupHead());
    await waitFor(() => expect(screen.queryByText('BK-001')).toBeNull());
  });

  it('grouping can be removed from its chip', async () => {
    renderList({ route: '/list?group_by=club' });
    await screen.findByText('Riverside Club');
    fireEvent.click(screen.getByText(/Grouped by Club/));
    await waitFor(() => expect(lastParams().group_by).toBeUndefined());
  });
});

// --------------------------------------------------------------------------- //
describe('pagination', () => {
  beforeEach(() => {
    fetcher = vi.fn(() => Promise.resolve({ results: ROWS, count: 120 }));
  });

  it('reports the window of records', async () => {
    renderList();
    expect(await screen.findByText('1-25')).toBeTruthy();
    expect(screen.getByText(/of 120/)).toBeTruthy();
  });

  it('moves to the next page', async () => {
    renderList();
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(lastParams().page).toBe(2));
  });

  it('changes the page size and returns to the first page', async () => {
    renderList({ route: '/list?page=3' });
    await screen.findByText('BK-001');
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '100' } });
    await waitFor(() => expect(lastParams().page_size).toBe(100));
  });

  it('defaults to 25 rows, not everything', async () => {
    renderList();
    await screen.findByText('BK-001');
    expect(lastParams().page_size).toBe(25);
  });
});

// --------------------------------------------------------------------------- //
describe('selection and bulk actions', () => {
  const run = vi.fn();
  const bulk = [{ key: 'export', label: 'Export selected', run }];

  beforeEach(() => run.mockClear());

  it('shows no checkboxes when the page offers no bulk action', async () => {
    renderList();
    await screen.findByText('BK-001');
    expect(screen.queryByLabelText('Select all rows on this page')).toBeNull();
  });

  it('selects one row', async () => {
    renderList({ bulkActions: bulk });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select row 1'));
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('selects every row on the page', async () => {
    renderList({ bulkActions: bulk });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('runs the bulk action with the selected ids and rows', async () => {
    renderList({ bulkActions: bulk });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select row 2'));
    fireEvent.click(screen.getByText('Export selected'));
    expect(run).toHaveBeenCalledWith([2], [ROWS[1]]);
  });

  it('clears the selection', async () => {
    renderList({ bulkActions: bulk });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select row 1'));
    fireEvent.click(screen.getByText(/Clear selection/));
    expect(screen.queryByText('1 selected')).toBeNull();
  });

  it('drops the selection when the query changes', async () => {
    renderList({ bulkActions: bulk, route: '/list?status=confirmed' });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select row 1'));
    expect(screen.getByText('1 selected')).toBeTruthy();

    // Rows the user can no longer see must not stay silently selected.
    fireEvent.click(screen.getByText(/Status: Confirmed/));
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  });

  it('ticking a row does not also open it', async () => {
    const onRowClick = vi.fn();
    renderList({ bulkActions: bulk, onRowClick });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByLabelText('Select row 1'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
describe('row actions', () => {
  it('only offers what the page passed in', async () => {
    const onEdit = vi.fn();
    renderList({ rowActions: () => [
      { key: 'edit', label: 'Edit', onClick: onEdit },
    ] });
    await screen.findByText('BK-001');

    fireEvent.click(screen.getAllByLabelText('Row actions')[0]);
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.queryByText('Delete')).toBeNull();
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('a permission-restricted action is simply absent', async () => {
    renderList({ rowActions: (row) => [
      { key: 'view', label: 'View', onClick: () => {} },
      row.status === 'confirmed' && { key: 'del', label: 'Delete', onClick: () => {} },
    ].filter(Boolean) });
    await screen.findByText('BK-002');

    fireEvent.click(screen.getAllByLabelText('Row actions')[1]);   // BK-002, pending
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('opening the menu does not open the row', async () => {
    const onRowClick = vi.fn();
    renderList({ onRowClick, rowActions: () => [{ key: 'v', label: 'View', onClick: () => {} }] });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getAllByLabelText('Row actions')[0]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('clicking the row itself opens the record', async () => {
    const onRowClick = vi.fn();
    renderList({ onRowClick });
    await screen.findByText('BK-001');
    fireEvent.click(screen.getByText('BK-001'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});

// --------------------------------------------------------------------------- //
describe('column visibility, order and width', () => {
  const openColumns = () => fireEvent.click(screen.getByRole('button', { name: /Columns/ }));

  it('hides a column and remembers it', async () => {
    const { unmount } = renderList();
    await screen.findByText('BK-001');
    openColumns();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Club' }));

    await waitFor(() => expect(
      queryHeader('Club')).toBeNull());

    unmount();
    renderList();
    await screen.findByText('BK-001');
    expect(queryHeader('Club')).toBeNull();
  });

  it('shows it again', async () => {
    renderList();
    await screen.findByText('BK-001');
    // The menu stays open between toggles, so several columns can be changed
    // in one visit rather than reopening it each time.
    openColumns();
    const item = () => screen.getByRole('menuitemcheckbox', { name: 'Club' });

    fireEvent.click(item());
    await waitFor(() => expect(queryHeader('Club')).toBeNull());
    fireEvent.click(item());
    await waitFor(() => expect(header('Club')).toBeTruthy());
  });

  it('never offers to hide a mandatory column', async () => {
    renderList();
    await screen.findByText('BK-001');
    openColumns();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Name' })).toBeNull();
  });

  it('persists the layout per table key', async () => {
    renderList();
    await screen.findByText('BK-001');
    openColumns();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Club' }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(prefsKey('test-table')));
      expect(stored.hidden).toContain('club');
    });
  });

  it('reset view restores columns and clears the query', async () => {
    renderList({ route: '/list?status=confirmed' });
    await screen.findByText('BK-001');
    openColumns();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Club' }));
    await waitFor(() => expect(
      queryHeader('Club')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Reset view/ }));
    await waitFor(() => {
      expect(header('Club')).toBeTruthy();
      expect(lastParams().status).toBeUndefined();
    });
  });

  it('a resizable header exposes a resize handle', async () => {
    renderList();
    await screen.findByText('BK-001');
    expect(screen.getByLabelText('Resize Club')).toBeTruthy();
  });

  it('headers are draggable for reordering', async () => {
    renderList();
    await screen.findByText('BK-001');
    const th = headerCell('Club');
    expect(th.getAttribute('draggable')).toBe('true');
  });
});

// --------------------------------------------------------------------------- //
describe('URL state', () => {
  it('reads search, filters and sort from the URL on load', async () => {
    renderList({ route: '/list?search=abc&status=confirmed&ordering=name&page=2' });
    await waitFor(() => {
      const p = lastParams();
      expect(p.search).toBe('abc');
      expect(p.status).toBe('confirmed');
      expect(p.ordering).toBe('name');
      expect(p.page).toBe(2);
    });
  });

  it('a page without a table key still works', async () => {
    renderList({ tableKey: null });
    expect(await screen.findByText('BK-001')).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
describe('ListTable used directly', () => {
  it('renders without any query handling, for embedded tables', () => {
    render(<ListTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('BK-001')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('respects a custom row key', () => {
    render(<ListTable columns={COLUMNS} rows={ROWS} selectable
      selectedIds={[]} onSelectionChange={() => {}} rowKey={(r) => r.name} />);
    expect(screen.getByLabelText('Select row BK-001')).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
describe('csv export', () => {
  it('uses the export value for a column that renders markup', () => {
    const created = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') { el.click = vi.fn(); created.push(el); }
      return el;
    });
    const blobs = [];
    const origBlob = global.Blob;
    global.Blob = class extends origBlob {
      constructor(parts, opts) { super(parts, opts); blobs.push(parts.join('')); }
    };
    global.URL.createObjectURL = vi.fn(() => 'blob:x');
    global.URL.revokeObjectURL = vi.fn();

    exportRowsToCsv(
      [{ id: 1, name: 'BK-001', total: '10.00' }],
      [{ key: 'name', header: 'Reference' },
       { key: 'total', header: 'Total', exportValue: (r) => r.total }],
      'bookings',
    );

    expect(blobs[0]).toContain('Reference,Total');
    expect(blobs[0]).toContain('BK-001,10.00');
    global.Blob = origBlob;
    document.createElement.mockRestore();
  });

  it('neutralises a value that a spreadsheet would treat as a formula', () => {
    const blobs = [];
    const origBlob = global.Blob;
    global.Blob = class extends origBlob {
      constructor(parts, opts) { super(parts, opts); blobs.push(parts.join('')); }
    };
    global.URL.createObjectURL = vi.fn(() => 'blob:x');
    global.URL.revokeObjectURL = vi.fn();
    const a = document.createElement('a');
    a.click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue(a);

    exportRowsToCsv([{ name: '=cmd|calc' }], [{ key: 'name', header: 'Name' }]);
    expect(blobs[0]).toContain("'=cmd|calc");

    global.Blob = origBlob;
    document.createElement.mockRestore();
  });
});
