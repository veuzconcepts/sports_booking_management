/**
 * Turn a DRF error payload into readable text.
 *
 * Handles the shapes DRF produces, including NESTED ones that a naive
 * `Object.entries(...).join(' ')` renders as "[object Object]":
 *   "a string"                          -> "a string"
 *   ["msg1", "msg2"]                    -> "msg1 msg2"
 *   { detail: "msg" }                   -> "msg"
 *   { field: ["msg"] }                  -> "Field: msg"
 *   { prices: [ {}, { price: ["x"] } ] } (many=True) -> "Prices: Price: x"
 */
function labelize(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatApiError(data, fallback = 'Request failed.') {
  const out = _format(data);
  return out || fallback;
}

function _format(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return String(data);

  if (Array.isArray(data)) {
    // List serializer / list of messages - drop empty entries (e.g. {} rows).
    return data.map(_format).filter(Boolean).join(' ');
  }

  // DRF top-level errors use `detail`; surface it on its own.
  if (typeof data.detail === 'string') return data.detail;

  return Object.entries(data)
    .map(([key, val]) => {
      const msg = _format(val);
      if (!msg) return '';
      // Numeric keys come from list indexes - keep just the message.
      return /^\d+$/.test(key) ? msg : `${labelize(key)}: ${msg}`;
    })
    .filter(Boolean)
    .join(' · ');
}

/** Convenience for axios errors: formatApiError(e.response?.data). */
export function apiErrorMessage(err, fallback = 'Request failed.') {
  return formatApiError(err?.response?.data, fallback);
}
