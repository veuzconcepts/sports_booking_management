"""Clubs — the physical venues that own bookable facilities.

A `Club` is one venue / location of the organization (a sports club, a leisure
centre, a club). Its bookable resources (courts, pitches, lanes, halls, rooms)
live in `apps.facilities` as `Facility` rows. Opening hours are the
`booking_hours` JSON on the club, resolved against the Organization default (and
overridden per facility) by `apps.settings_app.schedule` - the one schedule
engine. There is deliberately no second per-weekday table.
"""

from django.db import models


class Club(models.Model):
    """A venue the organization operates. Facilities and bookings hang off it."""

    code = models.SlugField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    address = models.CharField(max_length=255, blank=True)
    city = models.CharField(max_length=100, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(max_length=254, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    is_active = models.BooleanField(default=True)

    # --- Scheduling ---------------------------------------------------------
    # Per-club operating pattern, resolved by apps.settings_app.schedule.
    # EMPTY = inherit the organization entirely. A dict holding only some weekdays
    # overrides just those days and inherits the rest, so a unit that differs
    # only on Friday stores only Friday.
    booking_hours = models.JSONField(
        default=dict, blank=True,
        help_text="Weekday overrides. Empty inherits the organization.")
    slot_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="How often a slot starts, in minutes. Empty inherits the organization.")
    buffer_before_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Preparation time held before each booking. Empty inherits the organization.")
    buffer_after_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Changeover time held after each booking. Empty inherits the organization.")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name",)

    def __str__(self):
        return f"{self.name} ({self.code})"

