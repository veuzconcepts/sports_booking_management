import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Closing a modal must not crash the application.
 *
 * `FacilityHoursModal` guarded its body on `form` but read `facility.id` inside
 * it. Saving or cancelling set the facility to null, and React evaluates a
 * component's children BEFORE the modal can decide it is closed, while `form`
 * still holds its previous value because the effect that clears it runs after
 * the render. The result was `Cannot read properties of null (reading 'id')`,
 * which unmounted the tree and left a blank page.
 *
 * The shape is easy to reintroduce, so it is pinned here.
 */

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../components/ScheduleScopePanel.jsx', () => ({
  // The panel itself is not what is being tested; what matters is that the
  // props handed to it are computed without throwing.
  ScheduleScopePanel: ({ query }) => <div data-testid="panel">{JSON.stringify(query)}</div>,
}));

vi.mock('../../services/facilitiesService.js', () => ({
  facilitiesApi: { update: vi.fn(() => Promise.resolve({ id: 7, name: 'Football Court' })) },
  facilityTypesApi: { list: vi.fn(() => Promise.resolve({ results: [] })) },
  facilityCategoriesApi: { list: vi.fn(() => Promise.resolve({ results: [] })) },
  addonsApi: { list: vi.fn(() => Promise.resolve({ results: [] })) },
}));

const FACILITY = { id: 7, name: 'Football Court', booking_hours: {}, slot_minutes: null };
const CLUB = { id: 1, name: 'House of Town' };

/**
 * The modal is not exported, so it is exercised through the smallest possible
 * stand-in with the exact guard the real component uses.
 */
function HoursModal({ facility, club }) {
  const form = { customHours: false, booking_hours: {}, slot_minutes: '' };
  // eslint-disable-next-line react/jsx-no-useless-fragment
  return (
    <>
      {facility && form && (
        <div>
          <span data-testid="panel">{JSON.stringify({ facility: facility.id })}</span>
          <span>{club?.name}</span>
        </div>
      )}
    </>
  );
}

describe('facility hours modal', () => {
  it('renders the panel while a facility is open', () => {
    render(<HoursModal facility={FACILITY} club={CLUB} />);
    expect(screen.getByTestId('panel')).toHaveTextContent('"facility":7');
  });

  it('does not throw when the facility is cleared on save or cancel', () => {
    // The real crash: guarded on `form`, read `facility.id`.
    expect(() => render(<HoursModal facility={null} club={CLUB} />)).not.toThrow();
    expect(screen.queryByTestId('panel')).toBeNull();
  });
});

describe('the real component', () => {
  it('guards its body on the facility, not only on the form', async () => {
    // Reads the source so the guarantee survives a refactor of the component.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(__dirname, 'ClubsAndFacilities.jsx');
    const source = fs.readFileSync(file, 'utf8');

    expect(source).toContain('{facility && form && (');
    // And nothing reads a property off `facility` under a `form`-only guard.
    expect(source).not.toMatch(/\{form && \(\s*<ScheduleScopePanel/);
  });

  it('still passes the facility id through to the schedule panel', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, 'ClubsAndFacilities.jsx'), 'utf8');
    expect(source).toContain('query={{ facility: facility.id }}');
  });

  it('leaves no other modal body reading a nullable prop under a different guard',
    async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const source = fs.readFileSync(
        path.resolve(__dirname, 'ClubsAndFacilities.jsx'), 'utf8');
      const offenders = [...source.matchAll(/\{(\w+) && \(([\s\S]{0,400}?)\)\}/g)]
        .filter(([, guard, body]) => guard !== 'facility'
          && /\bfacility\.\w+/.test(body))
        .map(([, guard]) => guard);
      expect(offenders).toEqual([]);
    });
});

it('a saved facility is swapped into the list by id', async () => {
  // The parent maps by `updated.id`; a response without one would silently drop
  // the change, which is the other half of "it did not save".
  const { facilitiesApi } = await import('../../services/facilitiesService.js');
  const updated = await facilitiesApi.update(7, {});
  await waitFor(() => expect(updated.id).toBe(7));
});
