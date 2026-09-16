// Enterprise Title Case: capitalize each principal word, keep short
// articles/prepositions/conjunctions lowercase (except first/last word), and
// preserve acronyms / already-capitalized tokens (VAT, RTA, MFA, IP, ID…).
const SMALL = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'via', 'vs', 'with',
]);

export function titleCase(value) {
  if (typeof value !== 'string' || !value) return value;   // JSX / empty -> unchanged
  const tokens = value.split(/(\s+)/);                      // keep the whitespace
  const wordIdx = tokens.map((t, i) => (/\S/.test(t) ? i : -1)).filter((i) => i >= 0);
  const first = wordIdx[0];
  const last = wordIdx[wordIdx.length - 1];
  return tokens
    .map((token, i) => {
      if (!/\S/.test(token)) return token;                 // whitespace
      if (/[A-Z]/.test(token.slice(1))) return token;      // acronym / mixed-case -> keep
      const lower = token.toLowerCase();
      if (i !== first && i !== last && SMALL.has(lower)) return lower;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join('');
}
