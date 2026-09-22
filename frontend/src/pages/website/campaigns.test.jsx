import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../services/timeformat.jsx', () => ({
  useTimeFormat: () => ({ format24: true }),
  formatDateTime: (value) => String(value || ''),
  formatDate: (value) => String(value || ''),
  // The editor shows and reads campaign times in the organization's zone, so
  // the mock has to provide one or the module import is undefined.
  orgTimezone: () => 'Asia/Riyadh',
}));

const created = vi.fn();
const updated = vi.fn();

vi.mock('../../services/websiteService.js', async () => {
  const actual = await vi.importActual('../../services/websiteService.js');
  return {
    ...actual,
    websiteApi: {
      ...actual.websiteApi,
      campaigns: {
        list: () => Promise.resolve({ results: [], count: 0 }),
        create: (...args) => { created(...args); return Promise.resolve({}); },
        update: (...args) => { updated(...args); return Promise.resolve({}); },
        setPublished: () => Promise.resolve({}),
      },
    },
  };
});

vi.mock('../../services/promotionsService.js', () => ({
  promoCodesApi: { list: () => Promise.resolve({ results: [{ id: 5, code: 'RAMADAN20' }] }) },
}));

vi.mock('../../services/scheduleService.js', () => ({
  scheduleExceptionsApi: {
    list: () => Promise.resolve({
      results: [{ id: 9, name: 'National Day', start_date: '2027-12-02', end_date: '2027-12-03' }],
    }),
  },
}));

vi.mock('../../hooks/useFilterOptions.js', async () => {
  const actual = await vi.importActual('../../hooks/useFilterOptions.js');
  return { ...actual, useFilterOptions: () => ({ clubs: [{ id: 1, name: 'Riverside' }], facilityTypes: [] }) };
});

vi.mock('../../components/MediaPicker.jsx', () => ({
  MediaPicker: ({ label }) => <div data-testid="media-picker">{label}</div>,
}));

const { CampaignFormModal } = await import('./CampaignFormModal.jsx');
const { CampaignPreview } = await import('./CampaignPreview.jsx');

beforeEach(() => vi.clearAllMocks());

const openForm = (record = {}) => render(
  <CampaignFormModal open record={record} onClose={() => {}} onSaved={() => {}} />,
);

describe('campaign editor', () => {
  it('opens without crashing and offers the whole campaign', async () => {
    openForm();
    expect(await screen.findByLabelText(/campaign name/i)).toBeInTheDocument();
    expect(screen.getByText(/^artwork$/i)).toBeInTheDocument();
    expect(screen.getByText(/mobile artwork/i)).toBeInTheDocument();
  });

  it('refuses to save without a name', async () => {
    const toast = (await import('react-hot-toast')).default;
    openForm();
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(created).not.toHaveBeenCalled();
  });

  it('refuses to save without a period', async () => {
    const toast = (await import('react-hot-toast')).default;
    openForm();
    fireEvent.change(await screen.findByLabelText(/campaign name/i),
      { target: { value: 'Ramadan' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(created).not.toHaveBeenCalled();
  });

  it('sends the period as entered, for the server to read in its own timezone', async () => {
    openForm();
    fireEvent.change(await screen.findByLabelText(/campaign name/i),
      { target: { value: 'Ramadan' } });
    fireEvent.change(screen.getByLabelText(/^starts/i),
      { target: { value: '2027-03-01T00:00' } });
    fireEvent.change(screen.getByLabelText(/^ends/i),
      { target: { value: '2027-03-30T23:59' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(created.mock.calls[0][0]).toMatchObject({
      name: 'Ramadan',
      starts_at: '2027-03-01T00:00',
      ends_at: '2027-03-30T23:59',
    });
  });

  it('never sends the resolved media blocks back as if they were fields', async () => {
    openForm({ id: 3, name: 'Existing', starts_at: '2027-03-01T00:00:00Z',
      ends_at: '2027-03-30T23:59:00Z', image_detail: { id: 1, url: '/x.png' } });
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updated).toHaveBeenCalled());
    const payload = updated.mock.calls[0][1];
    expect(payload).not.toHaveProperty('image_detail');
    expect(payload).not.toHaveProperty('mobile_image_detail');
  });

  it('defaults to the safe, least intrusive behaviour', async () => {
    openForm();
    fireEvent.change(await screen.findByLabelText(/campaign name/i),
      { target: { value: 'Quiet' } });
    fireEvent.change(screen.getByLabelText(/^starts/i), { target: { value: '2027-03-01T00:00' } });
    fireEvent.change(screen.getByLabelText(/^ends/i), { target: { value: '2027-03-02T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(created.mock.calls[0][0]).toMatchObject({
      frequency: 'session',      // not on every page view
      placement: 'home',
      priority: 20,
      dismissible: true,         // a customer can always close it
      audience: 'everyone',
    });
  });
});

describe('campaign preview', () => {
  const campaign = {
    title: 'Ramadan nights', subtitle: 'Late courts', cta_label: 'Book now',
    dismissible: true,
  };

  it('shows the card as the customer will see it', () => {
    render(<CampaignPreview campaign={campaign} device="desktop" />);
    expect(screen.getByText('Ramadan nights')).toBeInTheDocument();
    expect(screen.getByText('Book now')).toBeInTheDocument();
  });

  it('uses the portrait artwork on a phone', () => {
    render(<CampaignPreview
      campaign={campaign}
      image={{ url: '/wide.png' }}
      mobileImage={{ url: '/tall.png' }}
      device="mobile"
    />);
    expect(screen.getByRole('presentation', { hidden: true })
      || document.querySelector('img')).toBeTruthy();
    expect(document.querySelector('img').getAttribute('src')).toBe('/tall.png');
  });

  it('falls back to the main artwork when there is no mobile version', () => {
    render(<CampaignPreview campaign={campaign} image={{ url: '/wide.png' }} device="mobile" />);
    expect(document.querySelector('img').getAttribute('src')).toBe('/wide.png');
  });

  it('names the promo code it advertises without repeating its rules', () => {
    render(<CampaignPreview campaign={campaign} promoLabel="RAMADAN20" device="desktop" />);
    expect(screen.getByText('RAMADAN20')).toBeInTheDocument();
  });

  it('hides the close control when the campaign may not be dismissed', () => {
    const { container } = render(
      <CampaignPreview campaign={{ ...campaign, dismissible: false }} device="desktop" />,
    );
    expect(container.querySelector('.cmpp__close')).toBeNull();
  });

  it('says what is missing rather than showing an empty card', () => {
    render(<CampaignPreview campaign={{ dismissible: true }} device="desktop" />);
    expect(screen.getByText(/add artwork or a headline/i)).toBeInTheDocument();
  });
});
