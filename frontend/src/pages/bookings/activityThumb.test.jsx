import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { ActivityThumb, activityMark } from './ActivityThumb.jsx';

/**
 * The booked activity's photo, shown on the listing, the board and the detail
 * page from this one component.
 *
 * The interesting cases are all absences. Most catalogues have photos for some
 * activities and not others, so "no photo" is the normal state rather than the
 * edge case, and it has to look deliberate instead of broken.
 */
describe('activity thumbnail', () => {
  it('shows the photo when there is one', () => {
    const { container } = render(
      <ActivityThumb src="http://x.test/padel.png" name="Padel Court" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('http://x.test/padel.png');
  });

  it('falls back to initials rather than an empty hole', () => {
    // A row with nothing in the slot reads as a loading failure.
    const { container } = render(<ActivityThumb name="Padel Court" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('PC');
  });

  it('is decorative, because the activity name sits beside it everywhere', () => {
    // Announcing it too would make a screen reader say the activity twice.
    const { container } = render(
      <ActivityThumb src="http://x.test/p.png" name="Padel Court" />);
    const img = container.querySelector('img');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not block the page waiting for pictures', () => {
    const { container } = render(<ActivityThumb src="http://x.test/p.png" name="X" />);
    expect(container.querySelector('img').getAttribute('loading')).toBe('lazy');
  });

  it('keeps one size for the image and its fallback', () => {
    // Different sizes would make a list of mixed rows jump about.
    const withPhoto = render(<ActivityThumb src="http://x.test/p.png" name="A B" size={32} />);
    const without = render(<ActivityThumb name="A B" size={32} />);
    const a = withPhoto.container.firstChild.style;
    const b = without.container.firstChild.style;
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    expect(a.width).toBe('32px');
  });
});

describe('the initials fallback', () => {
  it('takes the first letter of each of the first two words', () => {
    expect(activityMark('Padel Court')).toBe('PC');
    expect(activityMark('Swimming Lane Deluxe')).toBe('SL');
  });

  it('takes two letters from a single word', () => {
    expect(activityMark('Badminton')).toBe('BA');
  });

  it('says something rather than nothing when there is no name', () => {
    // A draft may have no activity yet and still has to render.
    expect(activityMark('')).toBe('--');
    expect(activityMark(null)).toBe('--');
    expect(activityMark(undefined)).toBe('--');
  });

  it('is not confused by stray whitespace', () => {
    expect(activityMark('  Padel   Court  ')).toBe('PC');
  });
});
