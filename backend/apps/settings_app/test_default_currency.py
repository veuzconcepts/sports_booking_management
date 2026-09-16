"""New financial records must follow the CONFIGURED system currency.

The bug: `currency` defaulted to `settings.DEFAULT_CURRENCY`, read from the
environment ONCE when the model module was imported. Changing the currency in
Settings had no effect on anything created afterwards, and restarting only
helped if the `.env` happened to agree with the choice.

Every test here deliberately configures a currency that differs from
`settings.DEFAULT_CURRENCY`. Otherwise the assertions would pass on a machine
whose `.env` already matches, and would prove nothing.
"""

from datetime import date, time, timedelta

import pytest
from django.test import override_settings

from apps.bookings.models import Booking
from apps.payments.models import Invoice, Payment
from apps.settings_app.currency import get_default_currency, set_default_currency


@pytest.fixture
def codes(settings):
    """Two currencies, neither of which is the environment's value."""
    pool = [c for c in ("SAR", "AED", "GBP") if c != settings.DEFAULT_CURRENCY]
    return pool[0], pool[1]


@pytest.fixture
def currency(db, codes):
    """Configure the system currency; yields a setter for changing it again."""
    original = get_default_currency()

    def _set(code):
        set_default_currency(code)
        return code

    _set(codes[0])
    yield _set
    set_default_currency(original)


def test_the_configured_currency_wins_over_the_environment(currency, codes, db):
    assert Booking().currency == codes[0]
    # Even with the environment insisting otherwise, the admin's choice holds.
    with override_settings(DEFAULT_CURRENCY="JPY"):
        assert get_default_currency() == codes[0]
        assert Booking().currency == codes[0]


def test_a_new_booking_is_stamped_with_the_configured_currency(
        currency, codes, club, customer, facility_type, facilities):
    b = Booking.objects.create(
        customer=customer, club=club, facility_type=facility_type,
        scheduled_date=date.today() + timedelta(days=1), scheduled_time=time(10, 0),
    )
    assert b.currency == codes[0]


def test_changing_the_currency_applies_to_the_next_booking(
        currency, codes, club, customer, facility_type, facilities):
    first = Booking.objects.create(
        customer=customer, club=club, facility_type=facility_type,
        scheduled_date=date.today() + timedelta(days=1), scheduled_time=time(10, 0),
    )
    assert first.currency == codes[0]

    currency(codes[1])
    second = Booking.objects.create(
        customer=customer, club=club, facility_type=facility_type,
        scheduled_date=date.today() + timedelta(days=2), scheduled_time=time(10, 0),
    )
    assert second.currency == codes[1]

    # The existing record keeps what it was written with - money is never
    # retagged behind anyone's back.
    first.refresh_from_db()
    assert first.currency == codes[0]


def test_an_explicit_currency_is_still_respected(
        currency, club, customer, facility_type, facilities):
    b = Booking.objects.create(
        customer=customer, club=club, facility_type=facility_type,
        scheduled_date=date.today() + timedelta(days=1), scheduled_time=time(10, 0),
        currency="JPY",
    )
    assert b.currency == "JPY"


@pytest.mark.parametrize("model", [Payment, Invoice])
def test_payment_records_follow_the_same_configured_currency(currency, codes, model, db):
    """Bookings were not the only model reading the environment value."""
    assert model().currency == codes[0]


def test_the_api_reports_the_configured_currency(auth_api, currency, codes):
    body = auth_api.get("/api/v1/settings/currency/").json()
    assert body["currency"] == codes[0]


def test_changing_it_through_the_api_takes_effect_immediately(auth_api, currency, codes, db):
    resp = auth_api.put("/api/v1/settings/currency/", {"currency": codes[1]}, format="json")
    assert resp.status_code == 200, resp.content
    # No restart, no re-import: the very next record picks it up.
    assert Booking().currency == codes[1]


def test_an_unsupported_currency_is_refused(auth_api, currency, codes):
    resp = auth_api.put("/api/v1/settings/currency/", {"currency": "ZZZ"}, format="json")
    assert resp.status_code == 400
    assert Booking().currency == codes[0]
