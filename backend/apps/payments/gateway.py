"""Payment provider adapters.

A thin, swappable abstraction so the rest of the app never talks to a provider
directly. Everything downstream (`services.charge`, the split-payment service,
the public checkout) calls the same interface and never asks which provider is
active - that decision is made once, here, from `settings.PAYMENT_MODE`.

Three adapters ship:

* ``MockGateway``   - approves any positive amount. The historical back-office
                      behaviour, kept because staff "record a payment taken at
                      the counter" never had card details to validate.
* ``DemoCardGateway`` - simulates a card authorisation from real card input so
                      the genuine booking lifecycle can be exercised before a
                      provider is integrated. Test cards only.
* ``DisabledGateway`` - refuses every charge. What production resolves to when
                      no real provider is configured, so a missing integration
                      fails closed instead of pretending money arrived.

Card security: `CardDetails` is a transient value object. It is never stored on
a model, never written to a log, and its `repr` is redacted so it cannot leak
through a traceback or a debugger frame. Only the brand and the last four
digits ever leave this module.
"""

import re
import secrets
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from django.conf import settings


# --------------------------------------------------------------------------- #
# Results and card input
# --------------------------------------------------------------------------- #
@dataclass
class GatewayResult:
    success: bool
    reference: str
    failure_reason: str = ""
    # Safe-to-store card metadata. Never the PAN, never the CVV.
    card_brand: str = ""
    card_last4: str = ""
    # A stable machine code for the failure, so the UI can translate it rather
    # than displaying an English sentence the provider happened to return.
    failure_code: str = ""


@dataclass
class CardDetails:
    """Card input for one authorisation attempt.

    Transient by construction: nothing here is persisted or logged. `repr` is
    overridden because a dataclass would otherwise print the PAN and the CVV
    into any traceback that happens to capture this frame.
    """

    number: str = field(default="", repr=False)
    holder: str = ""
    expiry_month: int = 0
    expiry_year: int = 0
    cvv: str = field(default="", repr=False)

    def __repr__(self):                      # pragma: no cover - defensive only
        return f"CardDetails(holder={self.holder!r}, last4={self.last4!r})"

    __str__ = __repr__

    @property
    def digits(self) -> str:
        return re.sub(r"\D", "", self.number or "")

    @property
    def last4(self) -> str:
        return self.digits[-4:] if len(self.digits) >= 4 else ""

    @property
    def brand(self) -> str:
        return detect_brand(self.digits)


def detect_brand(digits: str) -> str:
    """Card scheme from the leading digits. Display only."""
    if not digits:
        return ""
    if digits.startswith("4"):
        return "visa"
    if re.match(r"^(5[1-5]|2[2-7])", digits):
        return "mastercard"
    if re.match(r"^3[47]", digits):
        return "amex"
    if digits.startswith("6"):
        return "discover"
    if re.match(r"^(50|5[6-9]|6)", digits):
        return "maestro"
    return "card"


def luhn_valid(digits: str) -> bool:
    """The check-digit test every card scheme uses. Catches typos, not fraud."""
    if not digits or not digits.isdigit() or len(digits) < 12:
        return False
    total, double = 0, False
    for ch in reversed(digits):
        value = int(ch)
        if double:
            value *= 2
            if value > 9:
                value -= 9
        total += value
        double = not double
    return total % 10 == 0


# --------------------------------------------------------------------------- #
# Demo test cards
# --------------------------------------------------------------------------- #
# Behaviour is keyed on the card number so a developer can reproduce a specific
# failure deliberately. These are simulator inputs, not credentials: they match
# the numbers the major providers publish for exactly this purpose, and they are
# only ever reachable while the demo adapter is active.
CARD_APPROVED = "4242424242424242"
CARD_DECLINED = "4000000000000002"
CARD_EXPIRED = "4000000000000069"
CARD_TIMEOUT = "4000000000000259"
CARD_ERROR = "4000000000000119"
CARD_INSUFFICIENT = "4000000000009995"

_SCENARIOS = {
    CARD_DECLINED: ("card_declined", "The card was declined. Try another card."),
    CARD_EXPIRED: ("expired_card", "The card has expired."),
    CARD_TIMEOUT: ("timeout", "The payment provider did not respond in time. Try again."),
    CARD_ERROR: ("processing_error", "The payment could not be processed. Try again."),
    CARD_INSUFFICIENT: ("insufficient_funds", "The card has insufficient funds."),
}

# What the checkout shows a tester. The approved card is listed first because it
# is the one anybody following a happy path needs.
DEMO_TEST_CARDS = [
    {"number": CARD_APPROVED, "outcome": "approved", "label": "Successful payment"},
    {"number": CARD_DECLINED, "outcome": "card_declined", "label": "Card declined"},
    {"number": CARD_INSUFFICIENT, "outcome": "insufficient_funds", "label": "Insufficient funds"},
    {"number": CARD_EXPIRED, "outcome": "expired_card", "label": "Expired card"},
    {"number": CARD_TIMEOUT, "outcome": "timeout", "label": "Provider timeout"},
    {"number": CARD_ERROR, "outcome": "processing_error", "label": "Processing error"},
]


def _validate_card(card: CardDetails) -> tuple[str, str] | None:
    """Field-level problems, as (code, message). None when the input is usable.

    This is the validation a real provider's client-side SDK would do before it
    ever reaches the network, reproduced so the demo flow exercises the same
    error handling the live flow will need.
    """
    digits = card.digits
    if not digits:
        return "invalid_number", "Enter the card number."
    if not luhn_valid(digits):
        return "invalid_number", "That card number is not valid."
    if not (card.holder or "").strip():
        return "invalid_holder", "Enter the name printed on the card."
    month, year = int(card.expiry_month or 0), int(card.expiry_year or 0)
    if not 1 <= month <= 12:
        return "invalid_expiry", "Enter a valid expiry month."
    if year < 100:                                   # two-digit year, e.g. 30
        year += 2000
    if not 2000 <= year <= 2100:
        return "invalid_expiry", "Enter a valid expiry year."
    today = date.today()
    # A card is good through the last day of its expiry month.
    if (year, month) < (today.year, today.month):
        return "expired_card", "That card has expired."
    cvv_len = 4 if card.brand == "amex" else 3
    if not re.fullmatch(rf"\d{{{cvv_len}}}", card.cvv or ""):
        return "invalid_cvv", f"Enter the {cvv_len}-digit security code."
    return None


# --------------------------------------------------------------------------- #
# Adapters
# --------------------------------------------------------------------------- #
class MockGateway:
    """Approves any positive amount. Used where no card input exists."""

    name = "mock"
    accepts_cards = False
    is_demo = True

    def charge(self, amount: Decimal, *, currency: str, method: str,
               card: CardDetails | None = None, metadata=None) -> GatewayResult:
        # A real gateway would call out over the network here. The mock declines
        # non-positive amounts and otherwise approves with a synthetic ref.
        if amount is None or Decimal(amount) <= 0:
            return GatewayResult(False, "", "Amount must be greater than zero.",
                                 failure_code="invalid_amount")
        return GatewayResult(True, f"{self.name}_{secrets.token_hex(8)}")

    def refund(self, gateway_reference: str, amount: Decimal) -> GatewayResult:
        if amount is None or Decimal(amount) <= 0:
            return GatewayResult(False, "", "Refund amount must be greater than zero.",
                                 failure_code="invalid_amount")
        return GatewayResult(True, f"{self.name}_rf_{secrets.token_hex(6)}")


class DemoCardGateway(MockGateway):
    """Simulated card authorisation driven by the submitted test card.

    The point is NOT to fake a booking: a demo authorisation returns through the
    same `GatewayResult` a live adapter will, so the caller runs the real
    availability revalidation, real pricing, real Payment/Invoice records and
    real confirmation. Only the network call is simulated.
    """

    name = "demo"
    accepts_cards = True
    is_demo = True

    def charge(self, amount: Decimal, *, currency: str, method: str,
               card: CardDetails | None = None, metadata=None) -> GatewayResult:
        if amount is None or Decimal(amount) <= 0:
            return GatewayResult(False, "", "Amount must be greater than zero.",
                                 failure_code="invalid_amount")
        if card is None:
            # No card input: the caller is recording money taken elsewhere.
            return GatewayResult(True, f"{self.name}_{secrets.token_hex(8)}")

        problem = _validate_card(card)
        if problem:
            code, message = problem
            return GatewayResult(False, "", message, failure_code=code,
                                 card_brand=card.brand, card_last4=card.last4)

        scenario = _SCENARIOS.get(card.digits)
        if scenario:
            code, message = scenario
            return GatewayResult(False, "", message, failure_code=code,
                                 card_brand=card.brand, card_last4=card.last4)

        return GatewayResult(
            True, f"{self.name}_{secrets.token_hex(8)}",
            card_brand=card.brand, card_last4=card.last4,
        )


class DisabledGateway:
    """Refuses everything. What production resolves to with no real provider.

    Failing closed is the whole point: a misconfigured production box must not
    silently fall through to a simulator and mark bookings paid.
    """

    name = "disabled"
    accepts_cards = False
    is_demo = False

    def charge(self, amount: Decimal, *, currency: str, method: str,
               card: CardDetails | None = None, metadata=None) -> GatewayResult:
        return GatewayResult(
            False, "", "Online payment is not available at the moment.",
            failure_code="payment_unavailable")

    def refund(self, gateway_reference: str, amount: Decimal) -> GatewayResult:
        return GatewayResult(
            False, "", "Online refunds are not available at the moment.",
            failure_code="payment_unavailable")


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #
def resolve_payment_mode() -> str:
    """The mode actually in force, after the production safety check.

    `PAYMENT_MODE=demo` only survives when demo is permitted (DEBUG, or an
    explicit `PAYMENT_ALLOW_DEMO` opt-in for a sandbox host). Anywhere else it
    degrades to `disabled`, which is why a production deployment left on the
    development default cannot simulate a successful charge.
    """
    mode = str(getattr(settings, "PAYMENT_MODE", "disabled") or "disabled").strip().lower()
    if mode == "demo" and not getattr(settings, "PAYMENT_ALLOW_DEMO", False):
        return "disabled"
    if mode == "live":
        # No live provider is integrated yet. Rather than approving charges with
        # the mock, refuse them: card payment turns itself off until a real
        # adapter is registered here.
        return "disabled"
    if mode not in ("demo", "disabled"):
        return "disabled"
    return mode


def get_gateway():
    """The active provider adapter (the single integration point to swap)."""
    if resolve_payment_mode() == "demo":
        return DemoCardGateway()
    return DisabledGateway()


def get_backoffice_gateway():
    """Adapter for staff-recorded money that never had card input.

    Reception taking cash or running a physical terminal is not an online
    authorisation, so it must not be blocked by the online provider being
    unconfigured. This keeps that path on the permissive mock it has always
    used, while the customer-facing card path goes through `get_gateway`.
    """
    return MockGateway()


def card_payment_available() -> bool:
    """Whether the checkout may offer online card payment at all."""
    return get_gateway().accepts_cards


def demo_cards_visible() -> bool:
    """Whether test card guidance may be shown. Never true in production."""
    gw = get_gateway()
    return bool(gw.accepts_cards and gw.is_demo)


def public_payment_config() -> dict:
    """What the customer checkout is allowed to know about payment.

    Test card numbers are included ONLY while the demo adapter is active, so the
    production website never receives them.
    """
    visible = demo_cards_visible()
    return {
        "card_enabled": card_payment_available(),
        "demo_mode": visible,
        "test_cards": DEMO_TEST_CARDS if visible else [],
        "test_expiry": "12/30" if visible else "",
        "test_cvv": "123" if visible else "",
    }
