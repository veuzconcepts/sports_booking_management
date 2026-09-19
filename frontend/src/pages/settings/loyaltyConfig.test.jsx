import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Loyalty configuration must render.
 *
 * The page went blank in the browser, which always means the component threw
 * during render and React unmounted the tree. A smoke render catches that class
 * of failure, which a build never will: the bundle compiles perfectly happily.
 */

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../hooks/useAuth.jsx', () => ({
  useAuth: () => ({ hasPerm: () => true, user: { id: 1 } }),
}));

const CONFIG = {
  earning_enabled: true,
  points_per_currency: '1.000',
  fixed_points_per_booking: 0,
  redemption_enabled: true,
  currency_per_point: '0.010',
  min_redeem_points: 100,
  max_redeem_points_per_booking: 0,
  max_redeem_percent: 0,
  stack_with_promo: true,
  stack_with_membership: false,
  expiry_enabled: false,
  expiry_months: 12,
};

vi.mock('../../services/loyaltyService.js', () => ({
  loyaltyApi: {
    getConfig: vi.fn(() => Promise.resolve(CONFIG)),
    updateConfig: vi.fn((data) => Promise.resolve(data)),
    listTiers: vi.fn(() => Promise.resolve({ results: [
      { id: 1, name: 'Silver', min_points: 0, multiplier: '1.00' },
      { id: 2, name: 'Gold', min_points: 1000, multiplier: '1.25' },
    ] })),
    deleteTier: vi.fn(() => Promise.resolve()),
  },
}));

async function renderPage() {
  const { default: LoyaltyConfiguration } = await import('./LoyaltyConfiguration.jsx');
  return render(
    <MemoryRouter>
      <LoyaltyConfiguration />
    </MemoryRouter>,
  );
}

describe('loyalty configuration page', () => {
  it('renders without throwing', async () => {
    const { container } = await renderPage();
    await waitFor(() => expect(container.textContent).not.toContain('Loading'));
    expect(container).not.toBeEmptyDOMElement();
  });

  it('shows the configuration once it loads', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
    });
  });

  it('lists the tiers it was given', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('Silver')).toBeInTheDocument();
      expect(screen.getByText('Gold')).toBeInTheDocument();
    });
  });
});
