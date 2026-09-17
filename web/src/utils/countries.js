// ISO 3166-1 alpha-2 lookup by country NAME, because the public API exposes
// `organization.country` as a display name rather than a code.
const ALIASES = {
  uae: 'ae',
  'united arab emirates': 'ae',
  usa: 'us',
  'united states of america': 'us',
  uk: 'gb',
  'great britain': 'gb',
  england: 'gb',
};

const CODES = (
  'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ '
  + 'CA CD CF CG CH CI CK CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ '
  + 'FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE '
  + 'KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN '
  + 'MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY QA RO RS '
  + 'RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT '
  + 'TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'
).split(' ');

// Last-resort default when the organization has no country set.
export const FALLBACK_PHONE_COUNTRY = 'ae';

let byName = null;
/** Lowercase ISO2 for a country name; '' when blank or unrecognised. */
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
      byName[c.toLowerCase()] = c.toLowerCase();
    });
  }
  return ALIASES[s] || byName[s] || '';
}

/** The country a phone input should start on, given the org's country name. */
export function phoneCountryFor(name) {
  return countryCodeFromName(name) || FALLBACK_PHONE_COUNTRY;
}
