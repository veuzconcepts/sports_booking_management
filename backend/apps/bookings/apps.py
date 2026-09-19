from django.apps import AppConfig


class BookingsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.bookings"
    label = "bookings"

    def ready(self):
        # Retire cached calendar availability whenever something that feeds it
        # is written. Signals rather than explicit calls at each call site, so
        # a write from the admin, a management command or a future code path
        # cannot leave the calendar showing a date that is no longer bookable.
        from django.db.models.signals import m2m_changed, post_delete, post_save

        from . import availability_cache

        def drop(sender, **kwargs):
            availability_cache.invalidate()

        from apps.clubs.models import Club
        from apps.facilities.models import Facility, MaintenanceBlock, PricingRule
        from apps.settings_app.models import Organization, ScheduleException

        from .models import Booking, BookingPolicy

        sources = (
            Booking,            # created, cancelled, rescheduled, deleted
            BookingPolicy,      # lead time, horizon, multi-slot rules
            MaintenanceBlock,   # closures
            ScheduleException,  # holidays and special dates
            Facility,           # its own hours, or being deactivated
            Club,               # club hours
            Organization,       # organization hours and timezone
            # The summary carries the offer badge, so a rule that is switched
            # off, re-dated or re-targeted has to retire the cached month with
            # it. Without this an offer could linger for the cache's lifetime.
            PricingRule,
        )
        for model in sources:
            post_save.connect(drop, sender=model, weak=False,
                              dispatch_uid=f"availability_cache:{model.__name__}:save")
            post_delete.connect(drop, sender=model, weak=False,
                                dispatch_uid=f"availability_cache:{model.__name__}:delete")

        # Re-targeting a rule is an M2M write, which fires no post_save on the
        # rule itself: moving an offer from one category to another would
        # otherwise leave the old category still advertising it.
        for relation in (PricingRule.categories, PricingRule.facility_types,
                         PricingRule.clubs, PricingRule.addons,
                         PricingRule.membership_plans):
            m2m_changed.connect(
                drop, sender=relation.through, weak=False,
                dispatch_uid=f"availability_cache:m2m:{relation.through.__name__}")
