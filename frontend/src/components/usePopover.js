import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A popover that is not trapped by whatever it was rendered inside.
 *
 * Menus were positioned absolutely against their trigger, which works until
 * the trigger sits in a box that scrolls: the table wrapper and the modal body
 * both do, and both clipped their menus on the rows nearest the bottom. The
 * caller renders the panel through a portal with the `style` returned here, so
 * the only thing that can clip it is the viewport.
 *
 * The panel flips above the trigger when there is no room below, and is
 * clamped to the viewport in both reading directions.
 *
 *   const { triggerRef, popRef, open, toggle, close, style } = usePopover();
 *   <button ref={triggerRef} onClick={toggle} />
 *   {open && createPortal(<div ref={popRef} style={style} />, document.body)}
 */
const GAP = 4;
const EDGE = 8;

export function usePopover({ width = 200, estimatedHeight = 200, align = 'end' } = {}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Measure the panel itself once it exists; the estimate only has to be
    // good enough for the first frame.
    const height = popRef.current?.offsetHeight || estimatedHeight;
    const panelWidth = popRef.current?.offsetWidth || width;

    const below = rect.bottom + GAP;
    const fitsBelow = below + height <= window.innerHeight - EDGE;

    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const atStart = align === 'start';
    // "end" means the panel's end edge lines up with the trigger's.
    let left = (atStart !== rtl) ? rect.left : rect.right - panelWidth;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - panelWidth - EDGE));

    setStyle({
      position: 'fixed',
      left,
      top: fitsBelow ? below : Math.max(EDGE, rect.top - GAP - height),
      width,
      maxHeight: fitsBelow
        ? Math.max(120, window.innerHeight - below - EDGE)
        : Math.max(120, rect.top - GAP - EDGE),
    });
  }, [width, estimatedHeight, align]);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen) place();
      return !wasOpen;
    });
  }, [place]);

  const close = useCallback(() => setOpen(false), []);

  // Re-measure once the panel has rendered, so the flip decision uses its real
  // height rather than the estimate.
  useEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    // The panel is positioned against the trigger, so anything that moves the
    // trigger closes it rather than leaving it stranded mid-page. Scrolling
    // INSIDE the panel is not that: a long list scrolls itself, and the time
    // picker scrolls to the selected hour the moment it opens.
    const onScroll = (e) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onMove = () => setOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return { triggerRef, popRef, open, setOpen, toggle, close, style };
}
