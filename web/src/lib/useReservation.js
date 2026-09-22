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

/**
 * Has this exact selection already run out in this tab?
 *
 * Exported so the wizard can decide WHERE to open after a reload. A customer
 * whose reservation expired and who then refreshes used to land back on the
 * payment step, looking at a dead countdown and a Pay button that would be
 * refused, with nothing asking the server again. The honest place to put them
 * is the step the expiry message already tells them to go to.
 *
 * This does not weaken the rule it sits beside. The deadline still means
 * something: refreshing grants nobody another ten minutes on the spot, it
 * returns them to choosing, which is the same explicit act "Pick times again"
 * asks for and has always allowed.
 */
export function selectionFinished(club, facilityType, slots) {
  const stored = readStored();
  if (!stored?.finished) return false;
  return stored.signature === signatureOf(club, facilityType, slots);
}

/**
 * Forget an expired selection, so choosing again claims a fresh window.
 *
 * The mark is cleared by LEAVING the checkout, which is the explicit act the
 * expiry message asks for. A reload never leaves anything: the page has no
 * memory of having been on the payment step, so nothing cleared the mark and
 * the customer was sent to the picker only to be bounced straight back to a
 * dead countdown. Opening the picker after a reload IS that act, so it clears
 * the mark the same way.
 *
 * Only ever clears a FINISHED entry. A live reservation keeps its token here,
 * and throwing that away would put a court the customer is still paying for
 * back on sale.
 */
export function clearFinishedSelection() {
  if (!readStored()?.finished) return false;
  writeStored(null);
  return true;
}

/**
 * Should leaving this render give the courts back?
 *
 * Only on a real transition out of the checkout. Being inactive is not the
 * same as having left: a page load renders the wizard at its first step while
 * it reads the URL, and treating that as "left" discards a reservation the
 * customer is still in the middle of.
 */
export function shouldReleaseOnLeave(active, hasBeenActive) {
  return !active && hasBeenActive;
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
    // The club's choice, not the browser's. Defaults to showing, so a payload
    // that predates the setting behaves as it always did.
    showCountdown: true,
  });
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // What we last acted on, so a re-render does not re-claim.
  const claimedFor = useRef('');
  // Whether the checkout has actually been open in this page's life.
  const wasActive = useRef(false);

  const forget = useCallback(() => {
    writeStored(null);
    claimedFor.current = '';
    setState({ token: '', expiresAt: '', skewMs: 0, error: '', pending: false,
      showCountdown: true });
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

      // This exact selection has already run out once. Do NOT quietly start a
      // new window: the whole point of a deadline is that it ends, and a
      // customer who only has to press F5 to get another ten minutes can hold
      // a Saturday evening court all afternoon. They are shown the ended
      // message until they do what it asks and choose again.
      if (stored?.signature === signature && stored.finished) {
        setState({
          token: '', expiresAt: stored.expiresAt || '', skewMs: 0,
          error: '', pending: false, showCountdown: true,
        });
        return;
      }

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
              showCountdown: data.show_countdown !== false,
            });
            return;
          }
          // It ended while the page was closed. Same rule: say so rather than
          // claiming again behind the customer's back.
          if (res.ok && data?.expires_at) {
            writeStored({ signature, expiresAt: data.expires_at, finished: true });
            if (!live) return;
            setState({
              token: '', expiresAt: data.expires_at, skewMs: 0,
              error: '', pending: false, showCountdown: true,
            });
            return;
          }
        } catch { /* fall through and claim a fresh one */ }
      }
      if (stored?.token) {
        // Either it is finished, or it is for times the customer has since
        // changed their mind about. Both have to go BEFORE we claim, and the
        // second one matters most: somebody who reserved 8pm, wandered off and
        // came back wanting 8pm and 9pm would otherwise be refused the 8pm
        // court by their own abandoned reservation, which reads exactly like
        // somebody else having taken it.
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
            showCountdown: data.show_countdown !== false,
          });
        } else {
          claimedFor.current = '';
          // Only a genuine slot conflict is the customer's problem, and only
          // that message is worth showing: it names the time they need to
          // change. Anything else (throttled, server error, bad request) is
          // OUR problem. Checkout still works because the backend revalidates
          // availability before it writes, so showing "Request was throttled.
          // Expected available in 2615 seconds." would alarm somebody about a
          // booking that is going to go through perfectly well.
          const theirProblem = res.status === 409;
          setState({
            token: '', expiresAt: '', skewMs: 0, pending: false,
            error: theirProblem ? (data?.detail || '') : '',
            showCountdown: true,
          });
        }
      } catch {
        if (!live) return;
        claimedFor.current = '';
        // A reservation we could not make is not a reason to block checkout:
        // the backend revalidates availability before it writes anything, so
        // the worst case is the old behaviour of finding out at the last step.
        setState({ token: '', expiresAt: '', skewMs: 0, pending: false, error: '',
          showCountdown: true });
      }
    })();

    return () => { live = false; };
  }, [active, club?.id, facilityType?.id, signature, attempt, release, slots]);

  // Leaving the checkout gives the courts back rather than making the next
  // customer wait out a timer nobody is watching.
  //
  // "Leaving" is a TRANSITION, not simply being elsewhere, and the difference
  // is the whole bug this guard exists for. Every page load starts the wizard
  // at step one while it reads the URL, so an unguarded version released the
  // reservation on mount, before the restore had moved to the payment step. A
  // language switch therefore threw the reservation away and claimed a fresh
  // one: the countdown restarted at ten minutes, and the court went back on
  // sale for the moment in between.
  useEffect(() => {
    if (active) { wasActive.current = true; return undefined; }
    if (!shouldReleaseOnLeave(active, wasActive.current)) return undefined;
    wasActive.current = false;
    // Clears the stored entry whether or not there is still a token to give
    // back, which is what lets "Pick times again" actually start over: the
    // expired mark above is deliberately sticky until the customer leaves.
    const stored = readStored();
    if (stored) release(stored.token);
    return undefined;
  }, [active, release]);

  // Remember that this selection ran out, so a refresh cannot restart it.
  useEffect(() => {
    if (secondsLeft !== 0 || !state.expiresAt) return;
    const stored = readStored();
    if (stored?.signature === signature) {
      writeStored({ signature, expiresAt: state.expiresAt, finished: true });
    }
  }, [secondsLeft, state.expiresAt, signature]);

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
    showCountdown: state.showCountdown,
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
