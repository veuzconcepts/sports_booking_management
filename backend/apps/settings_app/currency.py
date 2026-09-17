"""System default currency — stored in `SystemConfig`, cached, with a fallback.

`get_default_currency()` is the single source of truth used when creating
bookings, payments, wallets and invoices, so changing it from the Settings UI
applies to all new financial records.
"""

from decimal import (
    ROUND_CEILING,
    ROUND_DOWN,
    ROUND_FLOOR,
    ROUND_HALF_DOWN,
    ROUND_HALF_EVEN,
    ROUND_HALF_UP,
    ROUND_UP,
    Decimal,
)

from django.conf import settings
from django.core.cache import cache

CONFIG_KEY = "default_currency"
_CACHE_KEY = "default_currency_v1"

# Decimal rounding methods selectable per currency (Oracle-Fusion-style).
ROUNDING_METHODS = {
    "HALF_UP": ROUND_HALF_UP,        # 0.5 -> away from zero (default, most retail)
    "HALF_EVEN": ROUND_HALF_EVEN,    # banker's rounding
    "HALF_DOWN": ROUND_HALF_DOWN,
    "UP": ROUND_UP,
    "DOWN": ROUND_DOWN,              # truncate toward zero
    "CEILING": ROUND_CEILING,
    "FLOOR": ROUND_FLOOR,
}
DEFAULT_DECIMALS = 2
DEFAULT_ROUNDING = "HALF_UP"

# --- Currency master (Oracle-Fusion-style precision model) -----------------
# Each currency declares its STANDARD precision (`decimals` = display/storage
# minor units, ISO 4217). The enterprise concepts below default off `decimals`
# but can be overridden per currency:
#   * extended_precision   — decimals used for INTERNAL calculation (default +2);
#   * min_accountable_unit — smallest transactable amount (default 10^-decimals);
#   * rounding_method      — how FINAL amounts round (default HALF_UP).
# `decimals` stays the canonical standard-precision key (used app-wide + by the
# frontend), so existing callers are unaffected. Symbols are English-only for now.
# Internal-calculation precision (tax/discount/conversion/unit-price math) when a
# currency doesn't override it. Must be >= standard precision; high enough for
# unit-price multiplication before the line amount is rounded to precision.
DEFAULT_EXTENDED_PRECISION = 6


def _with_defaults(entries):
    out = []
    for c in entries:
        d = dict(c)
        d.setdefault("rounding_method", DEFAULT_ROUNDING)
        d.setdefault("extended_precision", max(DEFAULT_EXTENDED_PRECISION, d["decimals"] + 2))
        d.setdefault("min_accountable_unit", str(Decimal(1).scaleb(-d["decimals"])))
        out.append(d)
    return out


CURRENCIES = _with_defaults([
    {"code": "USD", "label": "US Dollar", "symbol": "$", "decimals": 2},
    {"code": "EUR", "label": "Euro", "symbol": "€", "decimals": 2},
    {"code": "GBP", "label": "British Pound", "symbol": "£", "decimals": 2},
    {"code": "AED", "label": "UAE Dirham", "symbol": "AED", "decimals": 2},
    {"code": "SAR", "label": "Saudi Riyal", "symbol": "SR", "decimals": 2},
    {"code": "QAR", "label": "Qatari Riyal", "symbol": "QR", "decimals": 2},
    {"code": "BHD", "label": "Bahraini Dinar", "symbol": "BD", "decimals": 3},
    {"code": "KWD", "label": "Kuwaiti Dinar", "symbol": "KD", "decimals": 3},
    {"code": "OMR", "label": "Omani Rial", "symbol": "OMR", "decimals": 3},
    {"code": "JPY", "label": "Japanese Yen", "symbol": "¥", "decimals": 0},
    {"code": "KRW", "label": "South Korean Won", "symbol": "₩", "decimals": 0},
    {"code": "INR", "label": "Indian Rupee", "symbol": "₹", "decimals": 2},
    {"code": "PKR", "label": "Pakistani Rupee", "symbol": "₨", "decimals": 2},
    {"code": "AUD", "label": "Australian Dollar", "symbol": "A$", "decimals": 2},
    {"code": "CAD", "label": "Canadian Dollar", "symbol": "C$", "decimals": 2},
])
# Seed catalogue (also the fallback when the DB Currency master is empty/absent).
CURRENCY_CODES = [c["code"] for c in CURRENCIES]
CURRENCY_DECIMALS = {c["code"]: c["decimals"] for c in CURRENCIES}
_SEED_BY_CODE = {c["code"]: c for c in CURRENCIES}

_REGISTRY_CACHE_KEY = "currency_master_v1"


def invalidate_currency_cache():
    cache.delete(_REGISTRY_CACHE_KEY)


def currency_registry() -> dict:
    """`code -> meta` from the DB Currency master (cached 5 min). Falls back to the
    bundled seed catalogue when the table is empty or absent (fresh DB / migrating),
    so money handling never breaks during bootstrap."""
    data = cache.get(_REGISTRY_CACHE_KEY)
    if data is None:
        data = {}
        try:
            from .models import Currency
            for c in Currency.objects.all():
                data[c.code] = {
                    "code": c.code, "label": c.name, "symbol": c.symbol,
                    "decimals": c.precision, "extended_precision": c.extended_precision,
                    "min_accountable_unit": str(c.minimum_accountable_unit.normalize()),
                    "rounding_method": c.rounding_method, "is_active": c.is_active,
                }
        except Exception:   # table not migrated yet, etc.
            data = {}
        if not data:
            data = {k: dict(v) for k, v in _SEED_BY_CODE.items()}
        cache.set(_REGISTRY_CACHE_KEY, data, 300)
    return data


def active_currencies() -> list:
    """Active currency meta dicts (for dropdowns / the currency API)."""
    return [c for c in currency_registry().values() if c.get("is_active", True)]


def valid_currency_codes() -> list:
    return [c["code"] for c in active_currencies()]


def _meta(code: str | None) -> dict:
    reg = currency_registry()
    return reg.get(code or get_default_currency()) or _SEED_BY_CODE.get(code, {})


def decimals_for(code: str) -> int:
    """STANDARD precision — minor-unit decimals for a currency (default 2)."""
    return _meta(code).get("decimals", DEFAULT_DECIMALS)


def extended_precision(code: str | None = None) -> int:
    """Decimals for INTERNAL calculation (line items, %/tax math) — higher than
    standard so intermediate rounding doesn't accumulate. Default standard + 2."""
    m = _meta(code)
    return m.get("extended_precision", m.get("decimals", DEFAULT_DECIMALS) + 2)


def min_accountable_unit(code: str | None = None) -> Decimal:
    """Smallest transactable amount; FINAL amounts round to the nearest unit.
    Default 10^-decimals (e.g. USD 0.01, JPY 1, BHD 0.001)."""
    m = _meta(code)
    raw = m.get("min_accountable_unit")
    if raw is not None:
        return Decimal(str(raw))
    return Decimal(1).scaleb(-m.get("decimals", DEFAULT_DECIMALS))


def rounding_method(code: str | None = None) -> str:
    return _meta(code).get("rounding_method", DEFAULT_ROUNDING)


def _rounding(code: str | None) -> str:
    return ROUNDING_METHODS.get(rounding_method(code), ROUND_HALF_UP)


def money_exponent(currency: str | None = None) -> Decimal:
    """Quantize exponent at STANDARD precision, e.g. 2 dp -> Decimal('0.01')."""
    return Decimal(1).scaleb(-decimals_for(currency or get_default_currency()))


def _to_decimal(value) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value or 0))


def round_money(value, currency: str | None = None) -> Decimal:
    """Round a FINAL money amount to its currency: snap to the minimum accountable
    unit using the currency's rounding method, at standard precision. Use for any
    persisted/charged/invoiced/settled amount.

    Currency-aware: JPY -> 0 dp, USD/AED/SAR -> 2 dp, BHD/KWD/OMR -> 3 dp; honours
    a non-standard MAU (e.g. nearest 0.05). Defaults to the system currency.
    """
    cur = currency or get_default_currency()
    v = _to_decimal(value)
    mau = min_accountable_unit(cur)
    rnd = _rounding(cur)
    units = (v / mau).quantize(Decimal(1), rounding=rnd)   # nearest MAU
    return (units * mau).quantize(money_exponent(cur), rounding=rnd)


def round_extended(value, currency: str | None = None) -> Decimal:
    """Round an INTERMEDIATE value to the currency's extended precision. Use inside
    multi-step calculations; call round_money() once on the final result."""
    cur = currency or get_default_currency()
    exp = Decimal(1).scaleb(-extended_precision(cur))
    return _to_decimal(value).quantize(exp, rounding=_rounding(cur))


# --- Public Currency Master utilities (Oracle-Fusion-style) ----------------
def round_currency(value, currency: str | None = None) -> Decimal:
    """Round a FINAL amount (payable / invoice / receipt / settlement) to the
    currency's standard precision + minimum accountable unit, using its rounding
    method. Preferred name; `round_money`/`quantize_money` are aliases."""
    return round_money(value, currency)


def format_currency(amount, currency: str | None = None) -> str:
    """Display string at the currency's precision, e.g. 'AED 1,234.50', '¥ 1,235'."""
    cur = currency or get_default_currency()
    symbol = _meta(cur).get("symbol") or cur
    dp = decimals_for(cur)
    return f"{symbol} {round_currency(amount, cur):,.{dp}f}"


def validate_currency_precision(amount, currency: str | None = None,
                                field_type: str = "standard"):
    """Raise django ValidationError if `amount` carries more decimals than allowed.

    `field_type`: "standard"/"transaction" -> currency precision;
    "extended"/"unit_price" -> extended precision (high-precision unit prices).
    Trailing zeros are ignored (e.g. '5.00' is valid for JPY). Returns the Decimal.
    """
    from django.core.exceptions import ValidationError
    cur = currency or get_default_currency()
    v = _to_decimal(amount).normalize()
    exp = v.as_tuple().exponent
    places = -exp if isinstance(exp, int) and exp < 0 else 0
    extended = field_type in ("extended", "unit_price")
    allowed = extended_precision(cur) if extended else decimals_for(cur)
    if places > allowed:
        what = "unit-price" if extended else "transaction"
        raise ValidationError(
            f"{cur} {what} amounts allow at most {allowed} decimal place(s)."
        )
    return v


# Backwards-compatible alias — existing callers round FINAL amounts.
def quantize_money(value, currency: str | None = None) -> Decimal:
    return round_money(value, currency)


def get_default_currency() -> str:
    code = cache.get(_CACHE_KEY)
    if code is None:
        from .models import SystemConfig
        row = SystemConfig.objects.filter(key=CONFIG_KEY).first()
        code = (row.value or {}).get("code") if row else None
        code = code or getattr(settings, "DEFAULT_CURRENCY", "USD")
        cache.set(_CACHE_KEY, code, 600)
    return code


def set_default_currency(code: str) -> str:
    from .models import SystemConfig
    SystemConfig.objects.update_or_create(
        key=CONFIG_KEY,
        defaults={"value": {"code": code}, "description": "System default currency"},
    )
    cache.delete(_CACHE_KEY)
    return code
