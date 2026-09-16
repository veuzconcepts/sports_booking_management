"""Signal receivers that fire notifications on domain events.

Kept here (rather than in the bookings/payments apps) so those completed
modules stay untouched — the notifications app owns its own wiring.
"""

from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver

from apps.bookings.models import Booking, BookingStatus, BookingStatusHistory
from apps.payments.models import (
    CreditNote,
    CreditNoteStatus,
    Membership,
    MembershipStatus,
    Payment,
    PaymentStatus,
)
from apps.staff.models import StaffClubTransfer, TransferStatus

from .tasks import deliver_notification_task


def _customer_user(customer):
    # The customer's optional login account (None for guest/walk-in customers,
    # which correctly skips user-addressed notifications).
    return getattr(customer, "linked_user", None)


def notify(recipient, template_code, context=None, *, event=None):
    """Dispatch a notification to a user — async when a worker runs, else inline.

    No-op when there is no recipient (e.g. guest/walk-in customers with no login).
    """
    if recipient is None:
        return
    deliver_notification_task.delay(recipient.id, template_code, context or {}, event)


def _snapshot_prior(sender, instance, **kwargs):
    """Cache the pre-save row so the post_save receivers can fire on a real
    *transition* (status/validity change) rather than on every save. Connected
    for the models whose lifecycle notifications depend on what changed."""
    prior = sender.objects.filter(pk=instance.pk).first() if instance.pk else None
    instance._notif_prior = {
        "status": getattr(prior, "status", None),
        "end_date": getattr(prior, "end_date", None),
    }


for _model in (Membership, CreditNote, StaffClubTransfer):
    pre_save.connect(_snapshot_prior, sender=_model,
                     dispatch_uid=f"notif_snapshot_{_model.__name__}")


@receiver(post_save, sender=Booking, dispatch_uid="notify_booking_created")
def on_booking_created(sender, instance, created, **kwargs):
    if not created:
        return
    notify(
        _customer_user(instance.customer),
        "booking_confirmed",
        {
            "reference": instance.reference,
            "date": instance.scheduled_date.isoformat(),
            "time": instance.scheduled_time.strftime("%H:%M"),
            "total": str(instance.total_amount),
            "currency": instance.currency,
        },
        event="booking_created",
    )


@receiver(post_save, sender=BookingStatusHistory, dispatch_uid="notify_booking_completed")
def on_booking_completed(sender, instance, created, **kwargs):
    if not created or instance.to_status != BookingStatus.COMPLETED:
        return
    booking = instance.booking
    notify(
        _customer_user(booking.customer),
        "booking_completed",
        {"reference": booking.reference},
        event="booking_completed",
    )


@receiver(post_save, sender=Payment, dispatch_uid="notify_payment_received")
def on_payment_paid(sender, instance, created, **kwargs):
    if not created or instance.status != PaymentStatus.PAID:
        return
    notify(
        _customer_user(instance.customer),
        "payment_received",
        {
            "reference": instance.reference,
            "amount": str(instance.amount),
            "currency": instance.currency,
        },
        event="payment_received",
    )


def _welcome(instance):
    notify(
        _customer_user(instance.customer),
        "membership_welcome",
        {"plan": instance.plan.name, "end_date": instance.end_date.isoformat()},
        event="membership_created",
    )


@receiver(post_save, sender=Membership, dispatch_uid="notify_membership_welcome")
def on_membership_created(sender, instance, created, **kwargs):
    # Only a membership that starts ACTIVE is welcomed on creation. A customer's
    # own request lands as DRAFT and confers nothing yet — its welcome is sent
    # when staff activate it (see the draft → active transition below).
    if not created or instance.status != MembershipStatus.ACTIVE:
        return
    _welcome(instance)


@receiver(post_save, sender=Membership, dispatch_uid="notify_membership_lifecycle")
def on_membership_lifecycle(sender, instance, created, **kwargs):
    """Suspend / resume / cancel / expire / extend — fired on the transition only."""
    if created:
        return
    prior = getattr(instance, "_notif_prior", {})
    old_status, old_end = prior.get("status"), prior.get("end_date")
    recipient = _customer_user(instance.customer)
    ctx = {"number": instance.number, "plan": instance.plan.name,
           "end_date": instance.end_date.isoformat()}

    if instance.status != old_status:
        if instance.status == MembershipStatus.SUSPENDED:
            return notify(recipient, "membership_suspended", ctx, event="membership_suspended")
        # A requested membership confirmed by staff — welcome them now that it is live.
        if instance.status == MembershipStatus.ACTIVE and old_status == MembershipStatus.DRAFT:
            return _welcome(instance)
        if instance.status == MembershipStatus.ACTIVE and old_status == MembershipStatus.SUSPENDED:
            return notify(recipient, "membership_resumed", ctx, event="membership_resumed")
        if instance.status == MembershipStatus.CANCELLED:
            return notify(recipient, "membership_cancelled", ctx, event="membership_cancelled")
        if instance.status == MembershipStatus.EXPIRED:
            return notify(recipient, "membership_expired", ctx, event="membership_expired")

    # Validity pushed out (extend / renew), with or without a status change.
    if old_end and instance.end_date and instance.end_date > old_end:
        notify(recipient, "membership_extended", ctx, event="membership_extended")


@receiver(post_save, sender=CreditNote, dispatch_uid="notify_refund_outcome")
def on_refund_outcome(sender, instance, created, **kwargs):
    """Refund processed (direct or on approval) / rejected — to the customer."""
    if not instance.customer_id:
        return
    old_status = getattr(instance, "_notif_prior", {}).get("status")
    if instance.status == old_status:
        return
    recipient = _customer_user(instance.customer)
    ctx = {"number": instance.number, "amount": str(instance.total),
           "currency": instance.currency}
    if instance.status == CreditNoteStatus.ISSUED:
        notify(recipient, "refund_processed", ctx, event="refund_processed")
    elif instance.status == CreditNoteStatus.REJECTED:
        notify(recipient, "refund_rejected", ctx, event="refund_rejected")


@receiver(post_save, sender=StaffClubTransfer, dispatch_uid="notify_transfer_outcome")
def on_transfer_outcome(sender, instance, created, **kwargs):
    """Club transfer approved / completed — to the affected employee."""
    if created:
        return
    old_status = getattr(instance, "_notif_prior", {}).get("status")
    if instance.status == old_status:
        return
    recipient = getattr(instance.staff, "user", None)
    ctx = {"to_club": instance.to_club.name,
           "effective_date": instance.effective_date.isoformat()}
    if instance.status == TransferStatus.APPROVED:
        notify(recipient, "transfer_approved", ctx, event="transfer_approved")
    elif instance.status == TransferStatus.COMPLETED:
        notify(recipient, "transfer_completed", ctx, event="transfer_completed")
