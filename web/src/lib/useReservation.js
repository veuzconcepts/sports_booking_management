import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Holds the chosen courts while the customer fills in the checkout.
 *
 * Three things make this harder than a timer.
 *
 * **A refresh must find the same reservation.** Reloading the payment step and
 * claiming again would be refused, because the customer's own hold is already
 * on the court. That is the single worst failure this hook can have: it looks
 * exactly like somebody else taking the slot. So the token is kept in
 * `sessionStorage` under a signature of what was reserved, and a reload
 * re-reads the existing reservation instead of asking for a new one.
 *
 * **The deadline is the server's.** The countdown is anchored to the offset
 * between the server's clock and this device's, measured when the reservation
 * is issued. A phone twenty minutes fast would otherwise show a perfectly good
 * reservation as expired.
 *
 * **Changing the selection gives the courts back.** Somebody who returns to
 * the calendar has stopped wanting those times, and the next customer should
 * not wait out a timer for them.
 */

const STORE_KEY = 'bw:hold:v1';

/** What was reserved, as one comparable string. */
export function signatureOf(club, facilityType, slots) {
  const times = (slots || [])
    .map((s) => `${s.date} ${s.time}`)
    .sort()
    .join(',');
  return `${club?.id || ''}|${facilityType?.id || ''}|${times}`;
}

/** sessionStorage is per-tab and can throw (private mode, blocked storage). */
function readStored() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) sessionStorage.setItem(STORE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORE_KEY);
  } catch { /* the reservation still works, it just will not survive a reload */ }
}

/** Seconds left, measured against the server's clock rather than the device's. */
function remaining(expiresAt, skewMs) {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - (Date.now() + skewMs)) / 1000));
}

/**
 * @param {boolean} active  whether the checkout step is open
 * @returns {{token, secondsLeft, expired, pending, error, release, retry}}
 */
export function useReservation({ club, facilityType, slots, active }) {
  const signature = signatureOf(club, facilityType, slots);
  const [state, setState] = useState({
    token: '', expiresAt: '', skewMs: 0, error: '', pending: false,
  });
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // What we last acted on, so a re-render does not re-claim.
  const claimedFor = useRef('');

  const forget = useCallback(() => {
    writeStored(null);
    claimedFor.current = '';
    setState({ token: '', expiresAt: '', skewMs: 0, error: '', pending: false });
    setSecondsLeft(null);
  }, []);

  const release = useCallback(async (token) => {
    const raw = token || readStored()?.token;
    forget();
    if (!raw) return;
    try {
      await fetch(`/api/reserve?token=${encodeURIComponent(raw)}`, { method: 'DELETE' });
    } catch { /* the deadline will collect it */ }
  }, [forget]);

  useEffect(() => {
    if (!active || !club?.id || !facilityType?.id || !(slots || []).length) return undefined;
    if (claimedFor.current === signature && attempt === 0) return undefined;

    let live = true;
    claimedFor.current = signature;
    setState((s) => ({ ...s, pending: true, error: '' }));

    (async () => {
      const stored = readStored();
      // A reload, or a second visit to this step with the same times.
      if (stored?.token && stored.signature === signature) {
        try {
          const res = await fetch(`/api/reserve?token=${encodeURIComponent(stored.token)}`);
          const data = await res.json().catch(() => null);
          if (res.ok && data?.status === 'active' && data.seconds_remaining > 0) {
            if (!live) return;
            setState({
              token: stored.token, expiresAt: data.expires_at,
              skewMs: Date.parse(data.server_time) - Date.now(),
              error: '', pending: false,
            });
            return;
          }
        } catch { /* fall through and claim a fresh one */ }
        // Stale or finished: drop it before claiming, so the old reservation
        // cannot go on blocking the court we are about to ask for.
        await release(stored.token);
        if (!live) return;
      }

      try {
        const res = await fetch('/api/reserve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            club: club.id,
            facility_type: facilityType.id,
            slots: slots.map((s) => ({ date: s.date, time: s.time })),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!live) return;
        if (res.ok && data?.token) {
          writeStored({ token: data.token, signature, expiresAt: data.expires_at });
          setState({
            token: data.token, expiresAt: data.expires_at,
            skewMs: Date.parse(data.server_time) - Date.now(),
            error: '', pending: false,
          });
        } else {
          claimedFor.current = '';
          setState({
            token: '', expiresAt: '', skewMs: 0, pending: false,
            error: data?.detail || '',
          });
        }
      } catch {
        if (!live) return;
        claimedFor.current = '';
        // A reservation we could not make is not a reason to block checkout:
        // the backend revalidates availability before it writes anything, so
        // the worst case is the old behaviour of finding out at the last step.
        setState({ token: '', expiresAt: '', skewMs: 0, pending: false, error: '' });
      }
    })();

    return () => { live = false; };
  }, [active, club?.id, facilityType?.id, signature, attempt, release, slots]);

  // Leaving the checkout gives the courts back rather than making the next
  // customer wait out a timer nobody is watching.
  useEffect(() => {
    if (active) return undefined;
    const stored = readStored();
    if (stored?.token) release(stored.token);
    return undefined;
  }, [active, release]);

  // The ticking half. One interval, reading the anchored deadline.
  useEffect(() => {
    if (!state.expiresAt) { setSecondsLeft(null); return undefined; }
    const tick = () => setSecondsLeft(remaining(state.expiresAt, state.skewMs));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state.expiresAt, state.skewMs]);

  return {
    token: state.token,
    secondsLeft,
    expired: secondsLeft === 0 && !!state.expiresAt,
    pending: state.pending,
    error: state.error,
    release: () => release(state.token),
    retry: () => { forget(); setAttempt((n) => n + 1); },
  };
}

/** mm:ss, for the countdown. */
export function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
