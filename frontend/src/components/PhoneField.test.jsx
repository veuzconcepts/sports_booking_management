import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// The organization profile decides which country a phone field starts on.
const getOrg = vi.fn();
vi.mock('../services/settingsService.js', () => ({
  organizationApi: { get: (...a) => getOrg(...a) },
}));

const { PhoneField } = await import('./PhoneField.jsx');
const { _resetPhoneCountryCache } = await import('../hooks/useDefaultPhoneCountry.js');

const dialCode = () => screen.getByLabelText('Select country').textContent;

describe('PhoneField default country', () => {
  beforeEach(() => {
    _resetPhoneCountryCache();
    getOrg.mockReset();
  });

  it('starts on the organization country, not a hardcoded UAE', async () => {
    // The reported bug: org set to India, new-club form still offered +971.
    getOrg.mockResolvedValue({ country: 'India' });
    render(<PhoneField value="" onChange={() => {}} />);
    await waitFor(() => expect(dialCode()).toContain('+91'));
  });

  it('follows the organization when it changes country', async () => {
    getOrg.mockResolvedValue({ country: 'Saudi Arabia' });
    render(<PhoneField value="" onChange={() => {}} />);
    await waitFor(() => expect(dialCode()).toContain('+966'));
  });

  it('falls back to the UAE when no country is configured', async () => {
    getOrg.mockResolvedValue({ country: '' });
    render(<PhoneField value="" onChange={() => {}} />);
    await waitFor(() => expect(dialCode()).toContain('+971'));
  });

  it('falls back when organization settings cannot be read', async () => {
    // A user without settings permission must still get a usable field.
    getOrg.mockRejectedValue(new Error('403'));
    render(<PhoneField value="" onChange={() => {}} />);
    await waitFor(() => expect(dialCode()).toContain('+971'));
  });

  it('fetches the organization once however many fields are on screen', async () => {
    getOrg.mockResolvedValue({ country: 'India' });
    render(<><PhoneField value="" onChange={() => {}} />
            <PhoneField value="" onChange={() => {}} /></>);
    await waitFor(() => expect(getOrg).toHaveBeenCalledTimes(1));
  });

  it('an explicit defaultCountry still wins', async () => {
    getOrg.mockResolvedValue({ country: 'India' });
    render(<PhoneField value="" onChange={() => {}} defaultCountry="gb" />);
    await waitFor(() => expect(dialCode()).toContain('+44'));
    expect(dialCode()).not.toContain('+91');
  });

  it('an existing number keeps its own country', async () => {
    // Editing a club that already has a UK number must not be re-flagged to India.
    getOrg.mockResolvedValue({ country: 'India' });
    render(<PhoneField value="+442079460958" onChange={() => {}} />);
    await waitFor(() => expect(dialCode()).toContain('+44'));
  });

  it('shows a placeholder shaped for the selected country', async () => {
    getOrg.mockResolvedValue({ country: 'India' });
    render(<PhoneField value="" onChange={() => {}} />);
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(input.getAttribute('placeholder')).not.toBe('50 123 4567'));
    expect(input.getAttribute('placeholder')).toBeTruthy();
  });
});
