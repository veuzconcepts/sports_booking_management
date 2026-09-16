import { describe, expect, it } from 'vitest';

import { apiErrorMessage, formatApiError } from './apiError.js';

describe('formatApiError', () => {
  it('returns a plain string unchanged', () => {
    expect(formatApiError('Something broke')).toBe('Something broke');
  });

  it('surfaces a DRF detail on its own', () => {
    expect(formatApiError({ detail: 'Not found.' })).toBe('Not found.');
  });

  it('labels a field error', () => {
    expect(formatApiError({ facility_type: ['This field is required.'] }))
      .toBe('Facility Type: This field is required.');
  });

  it('joins a list of messages', () => {
    expect(formatApiError(['one', 'two'])).toBe('one two');
  });

  it('flattens nested many=True payloads without [object Object]', () => {
    const out = formatApiError({ entitlements: [{}, { quantity: ['Enter a number.'] }] });
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('Enter a number.');
  });

  it('falls back when there is nothing to show', () => {
    expect(formatApiError(null, 'Fallback.')).toBe('Fallback.');
    expect(formatApiError({}, 'Fallback.')).toBe('Fallback.');
  });
});

describe('apiErrorMessage', () => {
  it('reads the response body of an axios-shaped error', () => {
    const err = { response: { status: 400, data: { detail: 'Club not found' } } };
    expect(apiErrorMessage(err, 'Fallback.')).toBe('Club not found');
  });

  it('falls back when the request never reached the server', () => {
    expect(apiErrorMessage(new Error('Network Error'), 'Fallback.')).toBe('Fallback.');
  });
});
