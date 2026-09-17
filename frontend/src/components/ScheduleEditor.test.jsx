import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

// Assert against 24-hour text: the component honours the organization's
// preference, and pinning it keeps these assertions about layout, not locale.
vi.mock('../services/timeformat.jsx', () => ({
  useTimeFormat: () => ({ format24: true }),
}));

import { ScheduleEditor } from './ScheduleEditor.jsx';
import { DAY_KEYS, openDay, CLOSED_DAY } from '../utils/schedule.js';

const fullWeek = () => DAY_KEYS.reduce(
  (acc, d) => ({ ...acc, [d]: openDay('08:00', '22:00') }), {});

function renderEditor(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <ScheduleEditor
      scope="organization"
      value={props.value ?? fullWeek()}
      onChange={onChange}
      slotMinutes={60}
      onSlotMinutes={() => {}}
      bufferBefore={0}
      bufferAfter={0}
      onBuffers={() => {}}
      {...props}
    />,
  );
  return { ...utils, onChange };
}

const rowFor = (label) => screen.getByText(label).closest('.sch-row');

describe('compact weekly layout', () => {
  it('shows all seven days as one row each', () => {
    renderEditor();
    const rows = document.querySelectorAll('.sch-row');
    expect(rows).toHaveLength(7);
  });

  it('shows a day as a single readable line rather than six controls', () => {
    // The old editor rendered hour/minute/meridiem selects per time, which is
    // what made the page unusably long.
    renderEditor();
    const row = rowFor('Monday');
    expect(within(row).queryAllByRole('combobox')).toHaveLength(0);
    expect(row.textContent).toContain('08:00');
  });

  it('marks a closed day', () => {
    renderEditor({ value: { ...fullWeek(), sun: CLOSED_DAY } });
    expect(rowFor('Sunday').textContent).toContain('Closed');
  });

  it('flags an overnight day', () => {
    renderEditor({ value: { ...fullWeek(), fri: openDay('18:00', '02:00') } });
    expect(rowFor('Friday').textContent).toContain('Overnight');
  });

  it('counts a day\'s breaks without showing them all', () => {
    renderEditor({
      value: {
        ...fullWeek(),
        mon: { closed: false, shifts: [{ open: '08:00', close: '20:00' }],
          breaks: [{ open: '12:00', close: '13:00' }, { open: '17:00', close: '17:30' }] },
      },
    });
    expect(rowFor('Monday').textContent).toContain('2 breaks');
  });
});

describe('open and close', () => {
  it('closing a day clears its hours', () => {
    const { onChange } = renderEditor();
    fireEvent.click(within(rowFor('Monday')).getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mon: { closed: true, shifts: [], breaks: [] } }));
  });

  it('reopening a day restores the hours it had', () => {
    const previous = { closed: true, shifts: [], breaks: [] };
    const { onChange } = renderEditor({ value: { ...fullWeek(), mon: previous } });
    fireEvent.click(within(rowFor('Monday')).getByRole('checkbox'));
    expect(onChange.mock.calls[0][0].mon.closed).toBe(false);
    expect(onChange.mock.calls[0][0].mon.shifts).toHaveLength(1);
  });
});

describe('progressive disclosure', () => {
  it('detail controls are hidden until a day is opened', () => {
    renderEditor();
    expect(screen.queryByText('Operating hours')).toBeNull();
    expect(screen.queryByText('Add shift')).toBeNull();
  });

  it('clicking a day reveals its shifts and breaks', () => {
    renderEditor();
    fireEvent.click(screen.getByText('Monday'));
    expect(screen.getByText('Operating hours')).toBeTruthy();
    expect(screen.getByText('Add shift')).toBeTruthy();
    expect(screen.getByText('Add break')).toBeTruthy();
  });

  it('only one day is expanded at a time', () => {
    renderEditor();
    fireEvent.click(screen.getByText('Monday'));
    fireEvent.click(screen.getByText('Tuesday'));
    expect(document.querySelectorAll('.sch-detail')).toHaveLength(1);
  });
});

describe('copy a day', () => {
  it('copies Monday to every day', () => {
    const value = { ...fullWeek(), mon: openDay('06:00', '10:00') };
    const { onChange } = renderEditor({ value });

    fireEvent.click(screen.getByLabelText('Monday actions'));
    fireEvent.click(screen.getByText('All days'));

    const next = onChange.mock.calls[0][0];
    expect(DAY_KEYS.every((d) => next[d].shifts[0].open === '06:00')).toBe(true);
  });

  it('copies Monday to weekdays only', () => {
    const value = { ...fullWeek(), mon: openDay('06:00', '10:00') };
    const { onChange } = renderEditor({ value });

    fireEvent.click(screen.getByLabelText('Monday actions'));
    fireEvent.click(screen.getByText('Weekdays'));

    const next = onChange.mock.calls[0][0];
    expect(next.fri.shifts[0].open).toBe('06:00');
    expect(next.sat.shifts[0].open).toBe('08:00');     // weekend untouched
  });

  it('copies to one named day', () => {
    const value = { ...fullWeek(), mon: openDay('06:00', '10:00') };
    const { onChange } = renderEditor({ value });

    fireEvent.click(screen.getByLabelText('Monday actions'));
    // Scoped to the menu: "Wednesday" is also the label of its own row.
    const menu = document.querySelector('.sch-menu__pop');
    fireEvent.click(within(menu).getByText('Wednesday'));

    const next = onChange.mock.calls[0][0];
    expect(next.wed.shifts[0].open).toBe('06:00');
    expect(next.tue.shifts[0].open).toBe('08:00');
  });
});

describe('inheritance at a child scope', () => {
  const inherited = DAY_KEYS.reduce(
    (acc, d) => ({ ...acc, [d]: openDay('09:00', '23:00') }), {});

  it('shows inherited hours for a day the child has not overridden', () => {
    renderEditor({ scope: 'facility', parentLabel: 'Riverside Club',
      value: {}, inherited });
    expect(rowFor('Monday').textContent).toContain('09:00');
    expect(rowFor('Monday').textContent).toContain('Riverside Club');
  });

  it('marks an overridden day as custom', () => {
    renderEditor({ scope: 'facility', parentLabel: 'Riverside Club',
      value: { fri: openDay('15:00', '23:00') }, inherited });
    expect(rowFor('Friday').textContent).toContain('Custom');
    expect(rowFor('Monday').textContent).toContain('Riverside Club');
  });

  it('resetting a day removes it from the override rather than copying the parent', () => {
    // The whole point of real inheritance: the child must go back to following
    // the parent, not receive a private copy of the parent's current hours.
    const { onChange } = renderEditor({
      scope: 'facility', parentLabel: 'Riverside Club',
      value: { fri: openDay('15:00', '23:00') }, inherited,
    });

    fireEvent.click(screen.getByLabelText('Friday actions'));
    fireEvent.click(screen.getByText(/Reset to/));

    expect(onChange).toHaveBeenCalledWith({});
  });

  it('offers a reset for the whole week only when something is overridden', () => {
    const { rerender } = render(
      <ScheduleEditor scope="facility" parentLabel="Riverside Club"
        value={{}} inherited={inherited} onChange={() => {}}
        onResetAll={() => {}} slotMinutes={null} onSlotMinutes={() => {}}
        bufferBefore={null} bufferAfter={null} onBuffers={() => {}} />,
    );
    expect(screen.queryByText(/Reset every day/)).toBeNull();

    rerender(
      <ScheduleEditor scope="facility" parentLabel="Riverside Club"
        value={{ fri: openDay('15:00', '23:00') }} inherited={inherited}
        onChange={() => {}} onResetAll={() => {}} slotMinutes={null}
        onSlotMinutes={() => {}} bufferBefore={null} bufferAfter={null}
        onBuffers={() => {}} />,
    );
    expect(screen.getByText(/Reset every day/)).toBeTruthy();
  });
});

describe('validation feedback', () => {
  it('marks the offending day inline', () => {
    renderEditor({
      value: {
        ...fullWeek(),
        mon: { closed: false, shifts: [
          { open: '08:00', close: '13:00' }, { open: '12:00', close: '18:00' }] },
      },
    });
    expect(rowFor('Monday').textContent).toMatch(/overlap/i);
  });

  it('leaves valid days unmarked', () => {
    renderEditor();
    expect(document.querySelectorAll('.sch-row--invalid')).toHaveLength(0);
  });
});

describe('read-only mode', () => {
  it('disables editing without hiding the schedule', () => {
    renderEditor({ canEdit: false });
    expect(rowFor('Monday').textContent).toContain('08:00');
    expect(within(rowFor('Monday')).getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByLabelText('Monday actions')).toBeNull();
  });
});

/**
 * Hot / cold classification of an operating shift.
 *
 * The classification is stored ON the shift, so it inherits and is replaced
 * exactly as the hours are. The thing worth pinning here is that a normal
 * shift stays exactly as it was: writing `period: 'normal'` into every shift
 * would rewrite every stored schedule document for no reason.
 */
describe('peak and off-peak classification', () => {
  const openDayFor = (label) => {
    const row = rowFor(label);
    fireEvent.click(within(row).getByText('08:00').closest('button')
      || within(row).getAllByRole('button')[0]);
  };

  it('offers all three classifications on a shift', () => {
    renderEditor();
    const row = rowFor('Monday');
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const groups = screen.getAllByRole('group');
    const picker = groups.find((g) => g.className.includes('sch-period'));
    expect(picker).toBeTruthy();
    expect(picker.querySelectorAll('button')).toHaveLength(3);
  });

  it('marking a shift hot stores it on that shift', () => {
    const { onChange } = renderEditor();
    const row = rowFor('Monday');
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const picker = screen.getAllByRole('group')
      .find((g) => g.className.includes('sch-period'));
    fireEvent.click(picker.querySelectorAll('button')[1]);
    const week = onChange.mock.calls.at(-1)[0];
    expect(week.mon.shifts[0].period).toBe('hot');
  });

  it('returning a shift to normal removes the key rather than storing it', () => {
    // An untouched schedule document must stay byte-identical.
    const week = fullWeek();
    week.mon = { closed: false, shifts: [{ open: '08:00', close: '22:00', period: 'hot' }], breaks: [] };
    const { onChange } = renderEditor({ value: week });
    const row = rowFor('Monday');
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const picker = screen.getAllByRole('group')
      .find((g) => g.className.includes('sch-period'));
    fireEvent.click(picker.querySelectorAll('button')[0]);
    const next = onChange.mock.calls.at(-1)[0];
    expect('period' in next.mon.shifts[0]).toBe(false);
  });

  it('shows the classification without expanding the day', () => {
    const week = fullWeek();
    week.tue = { closed: false, shifts: [{ open: '08:00', close: '22:00', period: 'cold' }], breaks: [] };
    renderEditor({ value: week });
    const row = rowFor('Tuesday');
    // Queried by class, not by label text: the label is translated, and
    // this test is about the icon appearing, not about its wording.
    expect(row.querySelector('.sch-row__period--cold')).toBeTruthy();
  });
});
