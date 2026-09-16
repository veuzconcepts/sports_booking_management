"""Staff - the people who run the clubs and their facilities.

A `StaffProfile` extends an internal `User` (any non-customer role) with
employment metadata. `Shift` rows define when a staff member is available for
assignment. A daily `PerformanceSnapshot` captures bookings/day, average rating
and on-time %.
"""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext_lazy as _


class EmploymentType(models.TextChoices):
    FULL_TIME = "full_time", _("Full-time")
    PART_TIME = "part_time", _("Part-time")
    CONTRACT = "contract", _("Contract")


class StaffProfile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="staff_profile",
    )
    employee_id = models.CharField(max_length=20, unique=True)
    employment_type = models.CharField(
        max_length=12, choices=EmploymentType.choices,
        default=EmploymentType.FULL_TIME,
    )
    skills = models.CharField(
        max_length=255, blank=True,
        help_text="Comma-separated skill tags, e.g. 'tennis coaching, lifeguard'.",
    )
    base_club = models.ForeignKey(
        "clubs.Club",
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text="Home club (from the club master).",
    )
    hired_on = models.DateField(null=True, blank=True)
    is_available = models.BooleanField(
        default=True,
        help_text="Master on/off switch for new assignments.",
    )
    # Weekly working-hours template, same shape as Organization/Club booking_hours
    # ({mon..sun: {closed, shifts:[{open,close}]}}). Empty {} = no custom employee
    # schedule -> fall back to the club schedule, then the Organization default.
    shift_hours = models.JSONField(default=dict, blank=True)
    rating = models.DecimalField(
        max_digits=3, decimal_places=2, default=0,
        help_text="Rolling average customer rating, 0-5.",
    )
    notes = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("employee_id",)
        indexes = [
            models.Index(fields=["is_available"]),
        ]

    def __str__(self):
        return f"{self.employee_id} · {self.user.full_name}"

    @property
    def full_name(self) -> str:
        return self.user.full_name

    @property
    def role(self) -> str:
        return self.user.role


class Shift(models.Model):
    """A staff member's availability window on a given day."""

    staff = models.ForeignKey(
        StaffProfile,
        on_delete=models.CASCADE,
        related_name="shifts",
    )
    date = models.DateField(db_index=True)
    start_time = models.TimeField()
    end_time = models.TimeField()
    is_active = models.BooleanField(default=True)
    note = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("date", "start_time")
        indexes = [
            models.Index(fields=["date"]),
            models.Index(fields=["staff", "date"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["staff", "date", "start_time"],
                name="unique_staff_shift_start",
            ),
        ]

    def __str__(self):
        return f"{self.staff.employee_id} {self.date} {self.start_time}-{self.end_time}"

    def covers(self, at_time) -> bool:
        return self.start_time <= at_time < self.end_time

    def clean(self):
        """Reject backwards windows and shifts that overlap an existing one.

        Enforced here so the admin, the API, and any script all stay consistent.
        """
        if self.start_time and self.end_time and self.end_time <= self.start_time:
            raise ValidationError({"end_time": _("End time must be after start time.")})
        if self.staff_id and self.date and self.start_time and self.end_time and self.is_active:
            other = conflicting_shift(
                self.staff_id, self.date, self.start_time, self.end_time,
                exclude_pk=self.pk,
            )
            if other:
                raise ValidationError({"start_time": _(
                    "This shift overlaps an existing %(s)s-%(e)s shift on %(d)s."
                ) % {"s": other.start_time.strftime("%H:%M"),
                     "e": other.end_time.strftime("%H:%M"), "d": self.date}})


def conflicting_shift(staff_id, date, start_time, end_time, *, exclude_pk=None):
    """First ACTIVE shift for this staff member/date whose window overlaps
    [start_time, end_time). Returns the conflicting Shift, or None."""
    qs = Shift.objects.filter(
        staff_id=staff_id, date=date, is_active=True,
        start_time__lt=end_time, end_time__gt=start_time,
    )
    if exclude_pk:
        qs = qs.exclude(pk=exclude_pk)
    return qs.first()


class PerformanceSnapshot(models.Model):
    """Append-only daily performance roll-up per worker."""

    staff = models.ForeignKey(
        StaffProfile,
        on_delete=models.CASCADE,
        related_name="performance",
    )
    date = models.DateField(db_index=True)
    jobs_completed = models.PositiveSmallIntegerField(default=0)
    avg_rating = models.DecimalField(max_digits=3, decimal_places=2, default=0)
    on_time_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-date",)
        constraints = [
            models.UniqueConstraint(
                fields=["staff", "date"],
                name="unique_staff_perf_per_day",
            ),
        ]

    def __str__(self):
        return f"{self.staff.employee_id} {self.date}: {self.jobs_completed} jobs"


class TransferStatus(models.TextChoices):
    PENDING = "pending_approval", _("Pending approval")
    APPROVED = "approved", _("Approved (scheduled)")
    COMPLETED = "completed", _("Completed")
    CANCELLED = "cancelled", _("Cancelled")


class TransferType(models.TextChoices):
    IMMEDIATE = "immediate", _("Immediate")
    SCHEDULED = "scheduled", _("Scheduled")


class ShiftOption(models.TextChoices):
    APPLY_CLUB = "apply_club", _("Apply destination club schedule")
    RETAIN = "retain_custom", _("Retain employee custom schedule")
    CONFIGURE = "configure", _("Configure new schedule later")


class StaffClubTransfer(models.Model):
    """An employee's move between clubs (maker-checker). Immutable history.

    The reassignment plan (chosen by the maker) and the impact snapshot (counts
    at creation) are stored so the record is auditable and historical reports
    keep the club that applied at the time — we never rewrite past records.
    """

    staff = models.ForeignKey(
        StaffProfile, on_delete=models.CASCADE, related_name="transfers")
    from_club = models.ForeignKey(
        "clubs.Club", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+")
    to_club = models.ForeignKey(
        "clubs.Club", on_delete=models.PROTECT, related_name="+")
    effective_date = models.DateField()
    transfer_type = models.CharField(
        max_length=10, choices=TransferType.choices, default=TransferType.IMMEDIATE)
    reason = models.CharField(max_length=255, blank=True)
    remarks = models.TextField(blank=True)
    status = models.CharField(
        max_length=20, choices=TransferStatus.choices,
        default=TransferStatus.PENDING, db_index=True)
    shift_option = models.CharField(
        max_length=14, choices=ShiftOption.choices, default=ShiftOption.APPLY_CLUB)
    # {"bookings": {"<id>": <staff_user_id>}}.
    # Empty = keep existing assignments.
    reassign_plan = models.JSONField(default=dict, blank=True)
    impact_snapshot = models.JSONField(default=dict, blank=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+")
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+")
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="+")
    cancel_reason = models.CharField(max_length=255, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["staff", "-created_at"]),
                   models.Index(fields=["status", "effective_date"])]

    def __str__(self):
        return f"{self.staff.employee_id}: {self.from_club_id}→{self.to_club_id} ({self.status})"
