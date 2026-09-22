"""Pytest bootstrap and shared domain fixtures.

The suite runs against a THROWAWAY database that pytest-django creates and drops
around the session (`test_<DB_NAME>`) - it never touches the configured
development data. Because the project's database is PostgreSQL, so is the test
database, which is what we want: partial unique constraints and
`select_for_update` (both load-bearing in the booking allocator) behave exactly
as they will in production.

To run against SQLite instead, export `USE_SQLITE=True` in the SHELL before
invoking pytest - not here. pytest-django configures Django during
`pytest_load_initial_conftests`, which fires before this file is imported, so
setting it in-process would be too late to affect `config.settings`.

Per-test isolation of throttle and lockout counters is handled by the autouse
`_clear_cache` fixture below, which is what keeps the auth tests from
rate-limiting each other.
"""

import os

os.environ.setdefault("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")

from datetime import date, time, timedelta  # noqa: E402
from decimal import Decimal  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _public_site_url(settings):
    """Every test runs as a correctly configured deployment.

    Django forces DEBUG off under test, so anything that refuses to work with
    an unconfigured public address (split payment links) would otherwise
    refuse in every test. A real address here is what a server actually has;
    the tests that care about the unconfigured case set it back themselves.
    """
    settings.PUBLIC_WEBSITE_URL = "https://book.testclub.example"


@pytest.fixture(autouse=True)
def _clear_cache():
    """Reset throttle + lockout counters between tests for isolation."""
    from django.core.cache import cache
    cache.clear()
    yield
    cache.clear()


# --------------------------------------------------------------------------- #
# Domain fixtures: Club -> Facility -> FacilityCategory -> FacilityType
# --------------------------------------------------------------------------- #
@pytest.fixture
def club(db):
    from apps.clubs.models import Club
    return Club.objects.create(code="riverside", name="Riverside Club", city="Dubai")


@pytest.fixture
def facilities(db, club):
    """Three active courts at the club - per-slot capacity is 3."""
    from apps.facilities.models import Facility
    return [Facility.objects.create(club=club, name=f"Court {i}") for i in (1, 2, 3)]


@pytest.fixture
def facility_category(db):
    from apps.facilities.models import FacilityCategory, FacilityKind
    return FacilityCategory.objects.create(
        name="Racket Sports", slug="racket-sports", kind=FacilityKind.OUTDOOR_COURT,
        base_price=Decimal("60.00"), base_duration_minutes=60,
    )


@pytest.fixture
def facility_type(db, facility_category):
    from apps.facilities.models import FacilityType
    ft = FacilityType.objects.create(
        name="Tennis Court", price=Decimal("60.00"), duration_minutes=60,
    )
    ft.categories.set([facility_category])
    return ft


@pytest.fixture
def customer(db):
    from apps.customers.models import Customer
    return Customer.objects.create(
        full_name="Layla Ahmed", email="layla@example.com", mobile_number="+971500000001")


@pytest.fixture
def tax_rate(db):
    from apps.settings_app.models import TaxRate
    return TaxRate.objects.create(
        name="VAT", rate=Decimal("0.0500"), country="UAE", is_default=True)


@pytest.fixture
def booking_on(db, customer, facility_type, club):
    """Factory: a saved, priced booking that holds a facility.

    Mirrors what `BookingCreateSerializer` does on a real request - size the
    booking, allocate a unit, then price it - so availability assertions reflect
    production. Pass `allocate=False` for a booking that holds nothing.
    """
    from apps.bookings.models import Booking
    from apps.bookings.services import FacilityUnavailable, allocate_facility

    def _make(on_date=None, at_time=None, allocate=True, **extra):
        b = Booking(
            customer=customer, facility_type=facility_type, club=club,
            scheduled_date=on_date or (date.today() + timedelta(days=1)),
            scheduled_time=at_time or time(10, 0),
            **extra,
        )
        b.save()
        b.compute_duration()
        if allocate:
            try:
                allocate_facility(b, commit=False)
            except FacilityUnavailable:
                pass
        b.compute_pricing()
        b.save()
        return b

    return _make


# --------------------------------------------------------------------------- #
# Accounts
# --------------------------------------------------------------------------- #
@pytest.fixture
def make_user(db):
    from django.contrib.auth import get_user_model
    from apps.accounts.access import ensure_role_defaults
    from apps.accounts.models import Role

    User = get_user_model()
    ensure_role_defaults()

    def _make(email, role=Role.ADMIN, password="TestPass!2024", **extra):
        return User.objects.create_user(
            email=email, password=password, first_name="Test", last_name="User",
            role=role, **extra)

    return _make


@pytest.fixture
def admin_user(make_user):
    from apps.accounts.models import Role
    return make_user("admin@example.com", role=Role.ADMIN)


@pytest.fixture
def api(db):
    """Unauthenticated DRF client."""
    from rest_framework.test import APIClient
    return APIClient()


@pytest.fixture
def auth_api(db, admin_user):
    """DRF client authenticated as an admin (force_authenticate skips CSRF)."""
    from rest_framework.test import APIClient
    client = APIClient()
    client.force_authenticate(user=admin_user)
    return client
