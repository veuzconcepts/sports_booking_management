"""Seed a small, realistic demo dataset for the Club & Facility Booking system.

Creates staff users (one per system role), a couple of clubs with facilities,
a facility catalogue (categories -> facility types -> add-ons), demo customers
and a handful of bookings across the lifecycle. Idempotent: re-running updates
rather than duplicates.

    python manage.py seed_demo
"""

from datetime import time, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.bookings.models import Booking, BookingSource, BookingStatus
from apps.bookings.services import FacilityUnavailable, allocate_facility
from apps.clubs.models import Club
from apps.customers.models import Customer, CustomerSource
from apps.facilities.models import (
    AddOn,
    Facility,
    FacilityCategory,
    FacilityKind,
    FacilityType,
)
from apps.notifications.models import NotificationChannel, NotificationTemplate
from apps.settings_app.models import SystemConfig, TaxRate, Weekday
from apps.staff.models import EmploymentType, Shift, StaffProfile

from ...access import ensure_role_defaults
from ...models import Role

User = get_user_model()

DEMO_PASSWORD = "DemoPass!2024"

STAFF_USERS = [
    ("superadmin@example.com", "Ali",    "Elkhidir", Role.SUPER_ADMIN),
    ("admin@example.com",      "Sara",   "Hassan",   Role.ADMIN),
    ("clubadmin@example.com",  "Nadia",  "Rahman",   Role.CLUB_ADMIN),
    ("manager@example.com",    "Omar",   "Khan",     Role.MANAGER),
    ("operator@example.com",   "Yasmin", "Ali",      Role.FACILITY_OPERATOR),
    ("staff1@example.com",     "Raj",    "Kumar",    Role.FACILITY_STAFF),
    ("staff2@example.com",     "Khaled", "Mansour",  Role.FACILITY_STAFF),
]

CLUBS = [
    ("main", "Riverside Club", "12 Riverside Drive", "Dubai"),
    ("north", "Northside Sports Centre", "88 North Avenue", "Dubai"),
]

# club code -> [(facility name, [facility type names it can serve])]
# "Hall A" deliberately serves two types: one physical room, bookable as either,
# and it can never double-book itself.
FACILITIES = {
    "main": [
        ("Tennis Court 1", ["Tennis Court"]),
        ("Tennis Court 2", ["Tennis Court"]),
        ("Padel Court A", ["Padel Court"]),
        ("Pool Lane 1", ["Swimming Lane"]),
    ],
    "north": [
        ("Football Pitch 1", ["Football Pitch"]),
        ("Badminton Court 1", ["Badminton Court"]),
        ("Hall A", ["Badminton Court", "Function Hall"]),
    ],
}

# name, slug, kind, duration, base_price
CATEGORIES = [
    ("Racket Sports", "racket-sports", FacilityKind.OUTDOOR_COURT, 60, Decimal("60")),
    ("Team Sports",   "team-sports",   FacilityKind.PITCH,         90, Decimal("120")),
    ("Aquatics",      "aquatics",      FacilityKind.AQUATIC,       60, Decimal("40")),
    ("Indoor Spaces", "indoor-spaces", FacilityKind.HALL,          120, Decimal("150")),
]

# name, [category slugs], duration, price
FACILITY_TYPES = [
    ("Tennis Court",    ["racket-sports"], 60,  Decimal("60")),
    ("Padel Court",     ["racket-sports"], 60,  Decimal("80")),
    ("Badminton Court", ["racket-sports"], 45,  Decimal("35")),
    ("Football Pitch",  ["team-sports"],   90,  Decimal("120")),
    ("Swimming Lane",   ["aquatics"],      60,  Decimal("40")),
    ("Function Hall",   ["indoor-spaces"], 120, Decimal("150")),
]

# name, code, price, duration
ADDONS = [
    ("Racket Hire",     "ADDON-RACKET",   Decimal("15"), 0),
    ("Ball Set",        "ADDON-BALLS",    Decimal("10"), 0),
    ("Floodlights",     "ADDON-LIGHTS",   Decimal("25"), 0),
    ("Towel Service",   "ADDON-TOWEL",    Decimal("8"),  0),
]

CUSTOMERS = [
    ("customer1@example.com", "Layla Ahmed",   "+971500000001"),
    ("customer2@example.com", "Hassan Noor",   "+971500000002"),
    ("customer3@example.com", "Priya Sharma",  "+971500000003"),
]

# customer email, facility type, club code, day offset, time, status
BOOKINGS = [
    ("customer1@example.com", "Tennis Court",   "main",  1, time(9, 0),  BookingStatus.CONFIRMED),
    ("customer2@example.com", "Padel Court",    "main",  2, time(11, 0), BookingStatus.ASSIGNED),
    ("customer3@example.com", "Football Pitch", "north", 0, time(14, 0), BookingStatus.IN_PROGRESS),
    ("customer1@example.com", "Swimming Lane",  "main", -2, time(10, 0), BookingStatus.COMPLETED),
]


class Command(BaseCommand):
    help = "Seed demo users, clubs, facilities, customers and bookings."

    @transaction.atomic
    def handle(self, *args, **options):
        ensure_role_defaults()

        self.stdout.write(self.style.MIGRATE_HEADING("-> Users"))
        users = {}
        for email, first, last, role in STAFF_USERS:
            user, created = User.all_objects.get_or_create(
                email=email,
                defaults={"first_name": first, "last_name": last, "role": role},
            )
            user.first_name, user.last_name, user.role = first, last, role
            user.is_active = True
            user.set_password(DEMO_PASSWORD)
            if role == Role.SUPER_ADMIN:
                user.is_staff = user.is_superuser = True
            user.save()
            users[email] = user
            self.stdout.write(f"  {'+' if created else '='} {email} ({role})")

        self.stdout.write(self.style.MIGRATE_HEADING("-> Clubs & facilities"))
        clubs = {}
        for code, name, address, city in CLUBS:
            club, _ = Club.objects.get_or_create(
                code=code, defaults={"name": name, "address": address, "city": city})
            club.name, club.address, club.city, club.is_active = name, address, city, True
            club.save()
            clubs[code] = club
            for weekday in Weekday.values:
            if created:
                booking.compute_duration()
                # Let the engine allocate a facility that can actually host the
                # type and is free for the whole interval.
                try:
                    allocate_facility(booking, commit=False)
                except FacilityUnavailable:
                    pass
                booking.compute_pricing()
                booking.save()
            self.stdout.write(f"  {'+' if created else '='} {booking.reference} ({st})")

        self.stdout.write(self.style.MIGRATE_HEADING("-> Settings"))
        TaxRate.objects.get_or_create(
            name="Standard VAT",
            defaults={"rate": Decimal("0.0500"), "country": "UAE", "is_default": True})
        SystemConfig.objects.get_or_create(
            key="brand", defaults={"value": {"name": "Club Booking"},
                                   "description": "Brand settings"})
        NotificationTemplate.objects.get_or_create(
            code="booking_created",
            defaults={"channel": NotificationChannel.EMAIL,
                      "subject": "Your booking is confirmed",
                      "body": "Hi {{ customer }}, your booking {{ reference }} is "
                              "scheduled for {{ date }} at {{ time }}."},
        )

        self.stdout.write(self.style.SUCCESS(
            f"\nDemo data ready. Staff sign-in password: {DEMO_PASSWORD}"))
