"""Mock payment gateway adapter.

A thin, swappable abstraction so the rest of the app never talks to a real
gateway directly. Phase 4 ships a deterministic mock that "approves" every
charge; a Stripe/Telr/etc. adapter can later implement the same interface.
"""

import secrets
from dataclasses import dataclass
from decimal import Decimal


@dataclass
class GatewayResult:
    success: bool
    reference: str
    failure_reason: str = ""


class MockGateway:
    name = "mock"

    def charge(self, amount: Decimal, *, currency: str, method: str, metadata=None) -> GatewayResult:
        # A real gateway would call out over the network here. The mock declines
        # non-positive amounts and otherwise approves with a synthetic ref.
        if amount is None or Decimal(amount) <= 0:
            return GatewayResult(False, "", "Amount must be greater than zero.")
        return GatewayResult(True, f"mock_{secrets.token_hex(8)}")

    def refund(self, gateway_reference: str, amount: Decimal) -> GatewayResult:
        if amount is None or Decimal(amount) <= 0:
            return GatewayResult(False, "", "Refund amount must be greater than zero.")
        return GatewayResult(True, f"mock_rf_{secrets.token_hex(6)}")


def get_gateway() -> MockGateway:
    """Return the active gateway adapter (single integration point to swap)."""
    return MockGateway()
