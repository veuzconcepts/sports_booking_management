"""Async payment/invoice tasks (run eagerly unless USE_CELERY=True)."""

import logging

from celery import shared_task

logger = logging.getLogger("payments.tasks")


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def render_invoice_pdf_task(self, invoice_id):
    """Render an invoice PDF off the request path (eager inline in dev/tests)."""
    from .models import Invoice
    from .pdf import render_invoice_pdf

    invoice = Invoice.objects.filter(pk=invoice_id).first()
    if invoice is None:
        return None
    try:
        render_invoice_pdf(invoice)
    except Exception as exc:  # pragma: no cover - retry path
        logger.exception("Invoice PDF render failed for %s", invoice_id)
        raise self.retry(exc=exc)
    return invoice_id


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def render_receipt_pdf_task(self, receipt_id):
    """Render a payment-receipt PDF off the request path (eager inline in dev/tests)."""
    from .models import Receipt
    from .pdf import render_receipt_pdf

    receipt = Receipt.objects.filter(pk=receipt_id).first()
    if receipt is None:
        return None
    try:
        render_receipt_pdf(receipt)
    except Exception as exc:  # pragma: no cover - retry path
        logger.exception("Receipt PDF render failed for %s", receipt_id)
        raise self.retry(exc=exc)
    return receipt_id


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def render_credit_note_pdf_task(self, credit_note_id):
    """Render a credit-note PDF off the request path (eager inline in dev/tests)."""
    from .models import CreditNote
    from .pdf import render_credit_note_pdf

    credit_note = CreditNote.objects.filter(pk=credit_note_id).first()
    if credit_note is None:
        return None
    try:
        render_credit_note_pdf(credit_note)
    except Exception as exc:  # pragma: no cover - retry path
        logger.exception("Credit-note PDF render failed for %s", credit_note_id)
        raise self.retry(exc=exc)
    return credit_note_id


@shared_task
def expire_memberships_task():
    """Beat-scheduled: expire active memberships past their end date.

    Mirrors `manage.py expire_memberships`; the membership list also expires
    lazily on load, so this is the headless backstop. Returns the count expired.
    """
    from .services import expire_due_memberships

    count = expire_due_memberships()
    if count:
        logger.info("expire_memberships_task expired %s membership(s).", count)
    return count
