import { describe, expect, it } from 'vitest';

import { isInternalPath } from './NotificationBell.jsx';

/**
 * A notification's link is followed with `navigate()`, so it must never be
 * able to leave this application.
 *
 * Today it cannot: the server is the only writer, it sets `/bookings/<id>`,
 * and the field is `read_only` on the API. This is the guard for the day one
 * of those stops being true. React Router treats a protocol-relative `//host`
 * and a leading backslash as somewhere else entirely, and the backslash form
 * is the one a `startsWith('//')` check misses.
 */
describe('following a notification link', () => {
  it('follows an ordinary internal path', () => {
    expect(isInternalPath('/bookings/1')).toBe(true);
    expect(isInternalPath('/dashboard')).toBe(true);
    expect(isInternalPath('/orders/12?tab=slots')).toBe(true);
  });

  it('refuses a protocol-relative URL', () => {
    expect(isInternalPath('//evil.example')).toBe(false);
  });

  it('refuses the backslash form, which is the one that gets missed', () => {
    expect(isInternalPath('/\\evil.example')).toBe(false);
    expect(isInternalPath('/\\\\evil.example')).toBe(false);
  });

  it('refuses an absolute URL', () => {
    expect(isInternalPath('https://evil.example')).toBe(false);
    expect(isInternalPath('javascript:alert(1)')).toBe(false);
  });

  it('refuses anything that is not a path at all', () => {
    expect(isInternalPath('')).toBe(false);
    expect(isInternalPath(null)).toBe(false);
    expect(isInternalPath(undefined)).toBe(false);
    expect(isInternalPath(42)).toBe(false);
    expect(isInternalPath('bookings/1')).toBe(false);
  });
});
