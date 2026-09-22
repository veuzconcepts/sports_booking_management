/**
 * The booked activity's photo, at a glance.
 *
 * A booking listing is a wall of near-identical rows, and the fastest way to
 * tell a padel court from a swimming lane is to look at it rather than read
 * it. The same square appears on the listing, the board and the detail page,
 * from one component, so a booking is recognisable in the same way wherever
 * it is seen.
 *
 * It falls back to initials rather than to a broken image or an empty hole:
 * most catalogues have photos for some activities and not others, and a row
 * with nothing in that slot reads as a loading failure. The board already drew
 * those initials, so the fallback is the shape people are used to.
 *
 * Decorative by default. The activity name sits beside it in every one of the
 * three places it is used, so announcing the image as well would make a screen
 * reader say everything twice.
 */

/** First letter of each of the first two words: "Padel Court" to "PC". */
export function activityMark(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '--';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function ActivityThumb({ src, name, size = 34, className = '' }) {
  const label = activityMark(name);
  const classes = `activity-thumb ${className}`.trim();
  const style = { width: size, height: size };

  if (!src) {
    return (
      <span className={`${classes} activity-thumb--mark`} style={style} aria-hidden="true">
        {label}
      </span>
    );
  }

  return (
    <img
      className={classes}
      style={style}
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      /* A photo that 404s leaves a broken-image glyph, which looks like a bug
         in the booking rather than a missing file in the catalogue. Swap to
         the initials the moment the load fails. */
      onError={(e) => {
        const holder = document.createElement('span');
        holder.className = `${classes} activity-thumb--mark`;
        holder.style.width = `${size}px`;
        holder.style.height = `${size}px`;
        holder.setAttribute('aria-hidden', 'true');
        holder.textContent = label;
        e.currentTarget.replaceWith(holder);
      }}
    />
  );
}
