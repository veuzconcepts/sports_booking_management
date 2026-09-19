import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { BookingRulesModal } from './BookingRulesModal.jsx';

/**
 * The booking rules editor.
 *
 * What matters here is the inheritance: a facility that states nothing must
 * send nothing, so it keeps following its club. The screen that quietly
 * materialised the inherited values into its own row would look identical and
 * would silently detach the facility the first time anybody opened it.
 */

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars?.count ? `${key}:${vars.count}` : key) }),
}));

const effective = vi.fn();
const create = vi.fn(() => Promise.resolve({ id: 9 }));
const update = vi.fn(() => Promise.resolve({ id: 9 }));
const remove = vi.fn(() => Promise.resolve());
const clearOverrides = vi.fn(() => Promise.resolve({ cleared: 3 }));

vi.mock('../../services/bookingsService.js', () => ({
  bookingPoliciesApi: {
    effective: (...args) => effective(...args),
    create: (...args) => create(...args),
    update: (...args) => update(...args),
    remove: (...args) => remove(...args),
    clearOverrides: (...args) => clearOverrides(...args),
  },
}));

const INHERITED = {
  allow_multiple_slots: true,
  allow_multiple_dates: true,
  require_consecutive_slots: false,
  min_slots_per_booking: 1,
  max_slots_per_booking: 4,
};

const SCOPE = { facility: { id: 7, name: 'Court 1' }, club: { id: 1, name: 'Riverside' } };

beforeEach(() => {
  vi.clearAllMocks();
  effective.mockResolvedValue({ rules: INHERITED, has_own_policy: false, policy: null });
});

function open(scope = SCOPE) {
  return render(<BookingRulesModal scope={scope} onClose={() => {}} onSaved={() => {}} />);
}

describe('booking rules editor', () => {
  it('asks the backend what applies rather than working it out', async () => {
    open();
    await waitFor(() => expect(effective).toHaveBeenCalledWith({ facility: 7 }));
  });

  it('asks by club when no facility is given', async () => {
    open({ club: { id: 1, name: 'Riverside' } });
    await waitFor(() => expect(effective).toHaveBeenCalledWith({ club: 1 }));
  });

  it('starts with everything inheriting when the scope has no row', async () => {
    open();
    await waitFor(() => expect(screen.getAllByText('inherit').length).toBeGreaterThan(0));
    // Every tri-state sits on Inherit, so nothing is accidentally pinned.
    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed.every((node) => node.textContent === 'inherit')).toBe(true);
  });

  it('saves nothing but nulls when the operator changes nothing', async () => {
    open();
    await waitFor(() => screen.getByText('allowMultipleSlots'));
    fireEvent.click(screen.getByText('common:actions.save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [payload] = create.mock.calls[0];
    // The facility must keep following its club, not freeze today's values.
    expect(payload.allow_multiple_slots).toBeNull();
    expect(payload.max_slots_per_booking).toBeNull();
    expect(payload.facility).toBe(7);
  });

  it('sends only the field that was actually overridden', async () => {
    open();
    await waitFor(() => screen.getByText('allowMultipleSlots'));
    // Turn the first rule explicitly off.
    const [group] = screen.getAllByRole('group');
    fireEvent.click(group.querySelectorAll('button')[2]);
    fireEvent.click(screen.getByText('common:actions.save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [payload] = create.mock.calls[0];
    expect(payload.allow_multiple_slots).toBe(false);
    expect(payload.require_consecutive_slots).toBeNull();
  });

  it('updates in place when the scope already has its own row', async () => {
    effective.mockResolvedValue({
      rules: INHERITED,
      has_own_policy: true,
      policy: { id: 42, allow_multiple_slots: true, max_slots_per_booking: 2 },
    });
    open();
    await waitFor(() => screen.getByText('allowMultipleSlots'));
    fireEvent.click(screen.getByText('common:actions.save'));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0]).toBe(42);
  });

  it('resetting deletes the row so the scope inherits again', async () => {
    effective.mockResolvedValue({
      rules: INHERITED, has_own_policy: true, policy: { id: 42 },
    });
    open();
    await waitFor(() => screen.getByText('resetToInherited'));
    fireEvent.click(screen.getByText('resetToInherited'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(42));
  });

  it('offers no reset when there is nothing of its own to remove', async () => {
    open();
    await waitFor(() => screen.getByText('allowMultipleSlots'));
    expect(screen.queryByText('resetToInherited')).toBeNull();
  });

  it('hides the detail rules until several slots are actually allowed', async () => {
    effective.mockResolvedValue({
      rules: { ...INHERITED, allow_multiple_slots: false },
      has_own_policy: false, policy: null,
    });
    open();
    await waitFor(() => screen.getByText('allowMultipleSlots'));
    expect(screen.queryByText('requireConsecutive')).toBeNull();
    // Turning it on reveals them.
    const [group] = screen.getAllByRole('group');
    fireEvent.click(group.querySelectorAll('button')[1]);
    await waitFor(() => expect(screen.getByText('requireConsecutive')).toBeInTheDocument());
  });

  it('states what is in effect, so inherit is never a mystery', async () => {
    open();
    await waitFor(() => expect(screen.getByText(/inEffectHere/)).toBeInTheDocument());
    expect(screen.getByText('upToNSlots:4')).toBeInTheDocument();
  });

  /**
   * A facility's booking rules panel once sat on "Loading" for ever when the
   * request failed: the catch cleared the flag but left the form null, and the
   * guard treated a null form as still loading. On the real screen that was an
   * unapplied migration, and the button simply looked dead.
   */
  it('shows the failure and offers a retry instead of loading for ever', async () => {
    effective.mockRejectedValueOnce(new Error('boom'));
    open();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText('common:state.loading')).toBeNull();

    const retry = screen.getByText('common:actions.retry');
    expect(effective).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    // The second attempt succeeds and the editor appears.
    await waitFor(() => expect(screen.getByText('allowMultipleSlots')).toBeInTheDocument());
    expect(effective).toHaveBeenCalledTimes(2);
  });

  it('cannot save a policy it never managed to load', async () => {
    effective.mockRejectedValueOnce(new Error('boom'));
    open();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(screen.getByText('common:actions.save'));
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * The same editor serves every level of the chain. "All clubs" is the
   * organization row, which always exists, so that scope saves rather than
   * creating a second default.
   */
  describe('scopes above a facility', () => {
    it('asks for the organization rules with no scope parameter', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 1, is_default: true },
        overrides: { clubs: 0, facilities: 0 },
      });
      render(<BookingRulesModal scope={{ organization: true }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => expect(effective).toHaveBeenCalledWith({}));
    });

    it('updates the organization row instead of creating another default', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 1, is_default: true },
        overrides: { clubs: 0, facilities: 0 },
      });
      render(<BookingRulesModal scope={{ organization: true }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => screen.getByText('allowMultipleSlots'));
      fireEvent.click(screen.getByText('common:actions.save'));
      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(create).not.toHaveBeenCalled();
      expect(update.mock.calls[0][0]).toBe(1);
    });

    it('names what is overriding below, because a change will not reach it', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 1, is_default: true },
        overrides: { clubs: 1, facilities: 4 },
      });
      render(<BookingRulesModal scope={{ organization: true }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => expect(screen.getByText('overridesBelow')).toBeInTheDocument());
      expect(screen.getByText(/clubsWithOwnRules: 1/)).toBeInTheDocument();
      expect(screen.getByText(/facilitiesWithOwnRules: 4/)).toBeInTheDocument();
    });

    it('clears every override below once confirmed', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 1, is_default: true },
        overrides: { clubs: 1, facilities: 4 },
      });
      render(<BookingRulesModal scope={{ organization: true }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => screen.getByText('applyToEverythingBelow'));
      fireEvent.click(screen.getByText('applyToEverythingBelow'));
      // Destructive for everything underneath, so it asks first.
      expect(clearOverrides).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('common:actions.apply'));
      await waitFor(() => expect(clearOverrides).toHaveBeenCalledWith(undefined));
    });

    it('clears only within the club when the scope is one club', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 5 },
        overrides: { clubs: 0, facilities: 2 },
      });
      render(<BookingRulesModal scope={{ club: { id: 1, name: 'Riverside' } }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => screen.getByText('applyToEverythingBelow'));
      fireEvent.click(screen.getByText('applyToEverythingBelow'));
      fireEvent.click(screen.getByText('common:actions.apply'));
      await waitFor(() => expect(clearOverrides).toHaveBeenCalledWith(1));
    });

    it('offers nothing to clear at a facility, which has nothing below it', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: false, policy: null,
        overrides: { clubs: 0, facilities: 0 },
      });
      open();
      await waitFor(() => screen.getByText('allowMultipleSlots'));
      expect(screen.queryByText('applyToEverythingBelow')).toBeNull();
      expect(screen.queryByText('nothingOverridesBelow')).toBeNull();
    });

    it('says so plainly when nothing below overrides', async () => {
      effective.mockResolvedValue({
        rules: INHERITED, has_own_policy: true, policy: { id: 1, is_default: true },
        overrides: { clubs: 0, facilities: 0 },
      });
      render(<BookingRulesModal scope={{ organization: true }}
        onClose={() => {}} onSaved={() => {}} />);
      await waitFor(() => expect(screen.getByText('nothingOverridesBelow')).toBeInTheDocument());
      expect(screen.queryByText('applyToEverythingBelow')).toBeNull();
    });
  });

  it('hard-codes no colours in its stylesheet', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(path.resolve(__dirname, 'bookingRules.css'), 'utf8');
    // One exception: white text on the brand fill has no token of its own.
    const colours = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(colours.filter((value) => value.toLowerCase() !== '#fff')).toEqual([]);
    expect(css).not.toMatch(/(margin|padding|text-align)[^;]*:\s*(left|right)/);
  });
});
