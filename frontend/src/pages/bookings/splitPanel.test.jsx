import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SplitPaymentPanel } from './SplitPaymentPanel.jsx';
import { setCurrencyForTests } from '../../services/currency.jsx';

/**
 * The split breakdown on a booking.
 *
 * What is worth pinning here is not the layout but the guarantees: it shows
 * nothing when a booking was paid normally, it names every payer with their own
 * amount and state, and it follows the organization's configured currency
 * rather than inventing one.
 */

vi.mock('react-i18next', () => ({
  // Return the key's last segment so assertions read against stable text and
  // do not break when the English wording is edited.
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('../../services/timeformat.jsx', () => ({
  formatDateTime: (value) => `at ${String(value || '')}`,
}));

const SPLIT = {
  id: 1,
  status: 'active',
  currency: 'SAR',
  expires_at: '2026-09-20T18:00:00Z',
  allocated: '400.000',
  paid: '200.000',
  shares: [
    { id: 11, name: 'Mohammed', is_organizer: true, amount: '100.000',
      status: 'paid', payment: 'PAY-A1B2C3D4' },
    { id: 12, name: 'Ali', is_organizer: false, amount: '100.000',
      status: 'paid', payment: 'PAY-E5F6A7B8' },
    { id: 13, name: 'Ahmed', is_organizer: false, amount: '100.000',
      status: 'pending', payment: null },
    { id: 14, name: 'Omar', is_organizer: false, amount: '100.000',
      status: 'pending', payment: null },
  ],
};

beforeEach(() => {
  setCurrencyForTests('SAR');
});

describe('split payment panel', () => {
  it('renders nothing for a booking that was not split', () => {
    const { container } = render(<SplitPaymentPanel splits={[]} currency="SAR" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the field is missing entirely', () => {
    const { container } = render(<SplitPaymentPanel currency="SAR" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists every participant with their own amount', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    expect(screen.getByText('Ali')).toBeInTheDocument();
    expect(screen.getByText('Ahmed')).toBeInTheDocument();
    expect(screen.getByText('Omar')).toBeInTheDocument();
    // Four shares of the same size: four cells, not one.
    expect(screen.getAllByText(/100\.00/)).toHaveLength(4);
  });

  it('shows the organizer as the organizer, not by name', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    expect(screen.getByText('split.organizer')).toBeInTheDocument();
    expect(screen.queryByText('Mohammed')).toBeNull();
  });

  it('distinguishes paid shares from pending ones', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    // The mock resolves each key to its fallback, which is the raw status code.
    expect(screen.getAllByText('paid')).toHaveLength(2);
    expect(screen.getAllByText('pending')).toHaveLength(2);
  });

  it('links each settled share to the payment that settled it', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    expect(screen.getByText('PAY-A1B2C3D4')).toBeInTheDocument();
    expect(screen.getByText('PAY-E5F6A7B8')).toBeInTheDocument();
  });

  it('follows the organization currency rather than a hard-coded one', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    const text = document.body.textContent;
    // SAR renders as its symbol, SR, through the shared currency service.
    expect(text).toContain('SR 400.00');
    expect(text).not.toContain('$');
    expect(text).not.toContain('USD');
  });

  it('uses the split row currency when it differs from the page default', () => {
    // A historical booking keeps the currency it was taken in; the panel must
    // not relabel it with today's setting.
    const other = { ...SPLIT, currency: 'AED' };
    render(<SplitPaymentPanel splits={[other]} currency="SAR" />);
    expect(document.body.textContent).toContain('AED');
  });

  it('only shows the expiry while the split is still collecting', () => {
    const { rerender } = render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    expect(screen.getByText('split.expires')).toBeInTheDocument();
    rerender(<SplitPaymentPanel splits={[{ ...SPLIT, status: 'completed' }]} currency="SAR" />);
    expect(screen.queryByText('split.expires')).toBeNull();
  });

  it('labels the table for assistive technology', () => {
    render(<SplitPaymentPanel splits={[SPLIT]} currency="SAR" />);
    expect(screen.getByRole('table', { name: 'split.tableCaption' })).toBeInTheDocument();
  });

  it('uses logical CSS properties so it mirrors under RTL', async () => {
    // A `text-align: left` here would leave Arabic columns ragged against the
    // wrong edge, which is the usual way an RTL layout breaks.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, 'splitPanel.css'), 'utf8');
    expect(css).toContain('text-align: start');
    expect(css).not.toMatch(/text-align:\s*(left|right)/);
    expect(css).not.toMatch(/(margin|padding)-(left|right):/);
  });

  it('hard-codes no colours', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, 'splitPanel.css'), 'utf8');
    // Every colour must come from a theme token, so branding and dark mode
    // both follow without this file being touched.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});
