// ISO 3166-1 alpha-2 codes; display names resolved via Intl.DisplayNames so we
// avoid bundling a country-name dependency. Returns [{ value, label }] (name as
// both, since Organization.country stores a plain name string), sorted A-Z.
const CODES = (
  'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ '
  + 'CA CD CF CG CH CI CK CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ '
  + 'FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE '
  + 'KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN '
  + 'MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY QA RO RS '
  + 'RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT '
  + 'TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'
).split(' ');

let cached = null;
export function countryOptions() {
  if (cached) return cached;
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* unsupported */ }
  cached = CODES
    .map((c) => { const n = (names && names.of(c)) || c; return { value: n, label: n }; })
    .sort((a, b) => a.label.localeCompare(b.label));
  return cached;
}

// Aliases for values that are not the Intl display name - legacy rows typed by
// hand, plus the shorthand people actually write.
const ALIASES = {
  uae: 'ae',
  'united arab emirates': 'ae',
  usa: 'us',
  'united states of america': 'us',
  uk: 'gb',
  'great britain': 'gb',
  england: 'gb',
};

let byName = null;
/**
 * ISO 3166-1 alpha-2 code (lowercase) for a country NAME, because
 * `Organization.country` stores a display name rather than a code. Returns ''
 * when the name is blank or unrecognised, so callers can fall back.
 */
export function countryCodeFromName(name) {
  const s = (name || '').trim().toLowerCase();
  if (!s) return '';
  if (!byName) {
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* unsupported */ }
    byName = {};
    CODES.forEach((c) => {
      const n = names && names.of(c);
      if (n) byName[n.toLowerCase()] = c.toLowerCase();
      byName[c.toLowerCase()] = c.toLowerCase();   // accept a code as-is too
    });
  }
  return ALIASES[s] || byName[s] || '';
}
