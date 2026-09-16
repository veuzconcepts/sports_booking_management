"""Backfill the derived `end_time` on bookings created before the field existed.

`end_time` is what the slot engine tests for interval overlap, so a row with a
NULL end_time would hold its facility for a zero-length window and let another
booking double-book it. Reverse is a no-op (the column simply goes away).
"""

from datetime import date, datetime, time, timedelta

from django.db import migrations

_EPOCH = date(2000, 1, 1)


def backfill_end_time(apps, schema_editor):
    Booking = apps.get_model("bookings", "Booking")
    updates = []
    for booking in Booking.objects.filter(end_time__isnull=True).only(
            "id", "scheduled_time", "duration_minutes"):
        if not booking.scheduled_time:
            continue
        end = (datetime.combine(_EPOCH, booking.scheduled_time)
               + timedelta(minutes=booking.duration_minutes or 0))
        booking.end_time = time(23, 59) if end.date() != _EPOCH else end.time()
        updates.append(booking)
    if updates:
        Booking.objects.bulk_update(updates, ["end_time"], batch_size=500)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("bookings", "0003_booking_end_time_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill_end_time, noop),
    ]
