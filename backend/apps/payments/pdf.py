"""VAT-compliant invoice PDF rendering via reportlab.

`render_invoice_pdf(invoice)` builds the PDF in memory and saves it onto the
invoice's `pdf` FileField. Kept dependency-light (reportlab only) so it runs
synchronously in dev; Phase 5 can move it to a Celery task for scale.
"""

import os
from decimal import Decimal
from io import BytesIO

from django.conf import settings
from django.core.files.base import ContentFile
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

# Embed the UAE "aed" font so AED renders as the new Dirham glyph (the font draws
# the string "AED" as the single symbol) instead of the letters "AED". Registered
# once at import; if the file is missing we fall back to the plain currency code.
_AED_FONT = None
_AED_FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "aed-Regular.ttf")
try:
    pdfmetrics.registerFont(TTFont("AEDSymbol", _AED_FONT_PATH))
    _AED_FONT = "AEDSymbol"
except Exception:  # pragma: no cover - missing/invalid font file
    _AED_FONT = None


def _amount(amount) -> str:
    return f"{amount:,.2f}"


def _money(amount, currency) -> str:
    """Plain-text money (used where a single font run is fine)."""
    return f"{currency} {_amount(amount)}"


def _draw_money_right(pdf, x, y, amount, currency, *, size=10, bold=False):
    """Right-align an amount so it ends at x. For AED, draw the symbol run in the
    embedded Dirham font and the number in Helvetica, measuring both so the line
    stays correctly right-aligned."""
    base = "Helvetica-Bold" if bold else "Helvetica"
    num = _amount(amount)
    if currency == "AED" and _AED_FONT:
        sym_text, sym_font = "AED ", _AED_FONT
    else:
        sym_text, sym_font = f"{currency} ", base
    sym_w = pdfmetrics.stringWidth(sym_text, sym_font, size)
    num_w = pdfmetrics.stringWidth(num, base, size)
    start = x - (sym_w + num_w)
    pdf.setFont(sym_font, size)
    pdf.drawString(start, y, sym_text)
    pdf.setFont(base, size)
    pdf.drawString(start + sym_w, y, num)


def _new_doc():
    """Start an A4 canvas; returns (pdf, width, height)."""
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    return buffer, pdf, width, height


_RED = colors.HexColor("#dc2626")
_AMBER = colors.HexColor("#d97706")


def _watermark(pdf, width, height, text, color=_RED):
    """Large diagonal status stamp behind the content (e.g. CANCELLED / REFUNDED)."""
    pdf.saveState()
    pdf.setFont("Helvetica-Bold", 90)
    pdf.setFillColor(color)
    try:
        pdf.setFillAlpha(0.10)
    except Exception:  # pragma: no cover - older reportlab without alpha
        pdf.setFillColor(colors.HexColor("#f0d2d2"))
    pdf.translate(width / 2, height / 2)
    pdf.rotate(38)
    pdf.drawCentredString(0, -20, text)
    pdf.restoreState()


def _org():
    from apps.settings_app.models import Organization
    try:
        return Organization.get_solo()
    except Exception:  # pragma: no cover - no DB (e.g. a pure unit test); blank fallback
        return Organization()


def _supplier_lines(org) -> list[str]:
    """Grey supplier address/contact lines under the company name."""
    lines = []
    if org.address:
        lines.append(org.address)
    loc = ", ".join(x for x in [getattr(org, "city", ""), getattr(org, "country", "")] if x)
    if loc:
        lines.append(loc)
    contact = "  ·  ".join(x for x in [getattr(org, "phone", ""), getattr(org, "email", "")] if x)
    if contact:
        lines.append(contact)
    return lines


def _header(pdf, width, height, title, *, marker=None, marker_color=_RED) -> float:
    """Supplier banner (name, address, TRN) + document title; returns next cursor_y.

    `marker` prints a coloured status tag under the title (e.g. "CANCELLED",
    "REFUNDED", "REFUND") so a downloaded copy is never mistaken for a live
    tax invoice. The supplier TRN is required on UAE tax documents.
    """
    org = _org()
    company = org.legal_name or org.name or getattr(settings, "COMPANY_NAME", "Club Booking")
    y = height - 22 * mm
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(20 * mm, y, company)
    pdf.setFont("Helvetica-Bold", 14)
    pdf.drawRightString(width - 20 * mm, y, title)
    if marker:
        pdf.setFont("Helvetica-Bold", 10)
        pdf.setFillColor(marker_color)
        pdf.drawRightString(width - 20 * mm, y - 6 * mm, marker)
        pdf.setFillColor(colors.black)

    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(colors.grey)
    for line in _supplier_lines(org):
        y -= 5 * mm
        pdf.drawString(20 * mm, y, line)
    pdf.setFillColor(colors.black)
    if org.trn:
        y -= 5 * mm
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawString(20 * mm, y, f"TRN: {org.trn}")
    return y


def _party(pdf, width, y, *, doc_label, number, issued_at, bill_to_name, bill_to_email="",
           bill_to_trn="", right_line=None) -> float:
    """Document number / issue date / billed-to block; returns the next cursor_y."""
    y -= 14 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(20 * mm, y, f"{doc_label}: {number}")
    pdf.drawRightString(width - 20 * mm, y, f"Issued: {issued_at:%Y-%m-%d}")
    y -= 7 * mm
    pdf.setFont("Helvetica", 10)
    pdf.drawString(20 * mm, y, f"Billed to: {bill_to_name or 'Walk-in customer'}")
    if right_line:
        pdf.drawRightString(width - 20 * mm, y, right_line)
    if bill_to_email:
        y -= 6 * mm
        pdf.drawString(20 * mm, y, bill_to_email)
    if bill_to_trn:
        y -= 6 * mm
        pdf.drawString(20 * mm, y, f"Recipient TRN: {bill_to_trn}")
    return y


def _items_header(pdf, width, y) -> float:
    y -= 14 * mm
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.rect(20 * mm, y - 2 * mm, width - 40 * mm, 8 * mm, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(22 * mm, y, "Description")
    pdf.drawRightString(width - 22 * mm, y, "Amount")
    pdf.setFillColor(colors.black)
    return y


def _invoice_cols(width, show_discount=True):
    """Right-edge x positions for the line-item money columns: (Gross, Discount, VAT).
    `disc_x` is None when no line carries a discount (the column is dropped). The
    line Total always right-aligns at `width - 22mm`."""
    vat_x = width - 50 * mm
    if show_discount:
        return (width - 112 * mm, width - 80 * mm, vat_x)
    return (width - 88 * mm, None, vat_x)


def _invoice_items_header(pdf, width, y, show_discount=True) -> float:
    """Header row for the per-line VAT table: Description + Gross/[Discount]/VAT/Total."""
    gross_x, disc_x, vat_x = _invoice_cols(width, show_discount)
    y -= 14 * mm
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.rect(20 * mm, y - 2 * mm, width - 40 * mm, 8 * mm, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 8.5)
    pdf.drawString(22 * mm, y, "Description")
    pdf.drawRightString(gross_x, y, "Price")
    if disc_x is not None:
        pdf.drawRightString(disc_x, y, "Discount")
    pdf.drawRightString(vat_x, y, "VAT")
    pdf.drawRightString(width - 22 * mm, y, "Amount")
    pdf.setFillColor(colors.black)
    return y


def _footer(pdf, width, text):
    pdf.setFont("Helvetica-Oblique", 8)
    pdf.setFillColor(colors.grey)
    pdf.drawCentredString(width / 2, 20 * mm, text)
    pdf.setFillColor(colors.black)


def _finish(buffer, pdf) -> bytes:
    pdf.showPage()
    pdf.save()
    buffer.seek(0)
    return buffer.getvalue()


# Invoice status -> (header marker, marker colour, diagonal watermark, footer note).
# Keeps a downloaded copy unambiguous per standard accounting practice.
_INVOICE_STAMP = {
    "cancelled": ("CANCELLED", _RED, "CANCELLED",
                  "This invoice was cancelled and is not payable."),
    "refunded": ("REFUNDED", _RED, "REFUNDED",
                 "This invoice was fully refunded by credit note."),
    "partially_refunded": ("PARTIALLY REFUNDED", _AMBER, None,
                           "This invoice was partially refunded by credit note."),
}


def build_invoice_bytes(invoice) -> bytes:
    """Render the invoice to PDF bytes."""
    buffer, pdf, width, height = _new_doc()
    marker, marker_color, watermark, note = _INVOICE_STAMP.get(
        invoice.status, (None, _RED, None, "Thank you for your business. This is a computer-generated invoice."))
    if watermark:
        _watermark(pdf, width, height, watermark, marker_color)
    cursor_y = _header(pdf, width, height, "TAX INVOICE", marker=marker, marker_color=marker_color)
    cursor_y = _party(
        pdf, width, cursor_y, doc_label="Invoice #", number=invoice.number,
        issued_at=invoice.issued_at,
        bill_to_name=invoice.bill_to_display, bill_to_email=invoice.bill_to_email, bill_to_trn=invoice.bill_to_trn,
        right_line=(f"Booking: {invoice.booking.reference}" if invoice.booking_id else None),
    )
    booking = invoice.booking
    # Per-line breakdown when this invoice covers the whole booking — each line shows
    # its own discount and VAT and the lines reconcile to the totals below. Delta /
    # payment / membership invoices fall back to a single summary line.
    lines = []
    if booking is not None and invoice.subtotal is not None:
        from apps.bookings.services import booking_line_breakdown
        if abs(Decimal(invoice.total) - Decimal(booking.total_amount or 0)) < Decimal("0.01"):
            lines = booking_line_breakdown(booking, tax_rate=invoice.tax_rate)

    any_incl = any(ln["tax_inclusive"] for ln in lines)
    show_disc = any(Decimal(str(ln["discount"])) > 0 for ln in lines)
    if lines:
        gross_x, disc_x, vat_x = _invoice_cols(width, show_disc)
        cursor_y = _invoice_items_header(pdf, width, cursor_y, show_disc)
        pdf.setFont("Helvetica", 9)
        for ln in lines:
            cursor_y -= 8 * mm
            label = ln["label"] + (" *" if ln["tax_inclusive"] else "")
            pdf.drawString(22 * mm, cursor_y, label[:46])
            _draw_money_right(pdf, gross_x, cursor_y, ln["gross"], invoice.currency, size=9)
            if disc_x is not None and Decimal(str(ln["discount"])) > 0:
                _draw_money_right(pdf, disc_x, cursor_y, ln["discount"], invoice.currency, size=9)
            _draw_money_right(pdf, vat_x, cursor_y, ln["tax"], invoice.currency, size=9)
            _draw_money_right(pdf, width - 22 * mm, cursor_y, ln["total"], invoice.currency, size=9)
    else:
        cursor_y = _items_header(pdf, width, cursor_y)
        cursor_y -= 12 * mm
        pdf.setFont("Helvetica", 10)
        desc = "Facility booking"
        if booking:
            desc = (booking.facility_type.name if booking.facility_type_id
                    else booking.facility_category.name if booking.facility_category_id
                    else desc)
        pdf.drawString(22 * mm, cursor_y, desc)
        _draw_money_right(pdf, width - 22 * mm, cursor_y, invoice.subtotal, invoice.currency)

    # Totals
    cursor_y -= 14 * mm
    pdf.line(120 * mm, cursor_y + 4 * mm, width - 20 * mm, cursor_y + 4 * mm)

    def total_row(label, amount, bold=False):
        nonlocal cursor_y
        pdf.setFont("Helvetica-Bold" if bold else "Helvetica", 10)
        pdf.drawRightString(150 * mm, cursor_y, label)
        _draw_money_right(pdf, width - 22 * mm, cursor_y, amount, invoice.currency, bold=bold)
        cursor_y -= 7 * mm

    total_row("Subtotal (excl. VAT)", invoice.subtotal)
    total_row(f"VAT ({invoice.tax_rate * 100:.0f}%)", invoice.tax_amount)
    total_row("Total", invoice.total, bold=True)

    if any_incl:
        cursor_y -= 2 * mm
        pdf.setFont("Helvetica-Oblique", 8)
        pdf.setFillColor(colors.grey)
        pdf.drawString(22 * mm, cursor_y, "* Price is VAT-inclusive - the VAT shown is the portion contained in it.")
        pdf.setFillColor(colors.black)

    _footer(pdf, width, note)
    return _finish(buffer, pdf)


def build_receipt_bytes(receipt) -> bytes:
    """Render a payment receipt (proof the invoice was paid)."""
    buffer, pdf, width, height = _new_doc()
    invoice = receipt.invoice
    cursor_y = _header(pdf, width, height, "PAYMENT RECEIPT")
    cursor_y = _party(
        pdf, width, cursor_y, doc_label="Receipt #", number=receipt.number,
        issued_at=receipt.issued_at,
        bill_to_name=invoice.bill_to_display, bill_to_email=invoice.bill_to_email, bill_to_trn=invoice.bill_to_trn,
        right_line=f"Invoice: {invoice.number}",
    )

    cursor_y -= 14 * mm
    pdf.setFont("Helvetica", 10)
    method = (receipt.method or "").replace("_", " ").title() or "-"
    pdf.drawString(20 * mm, cursor_y, f"Payment method: {method}")
    if invoice.booking_id:
        pdf.drawRightString(width - 20 * mm, cursor_y, f"Booking: {invoice.booking.reference}")

    # Amount paid — the headline figure.
    cursor_y -= 16 * mm
    pdf.line(120 * mm, cursor_y + 4 * mm, width - 20 * mm, cursor_y + 4 * mm)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawRightString(150 * mm, cursor_y, "Amount paid")
    _draw_money_right(pdf, width - 22 * mm, cursor_y, receipt.amount, receipt.currency,
                      size=11, bold=True)

    _footer(pdf, width, "Payment received with thanks. This is a computer-generated receipt.")
    return _finish(buffer, pdf)


def build_credit_note_bytes(credit_note) -> bytes:
    """Render a VAT credit note — the refund document that reverses an invoice."""
    buffer, pdf, width, height = _new_doc()
    invoice = credit_note.invoice
    cursor_y = _header(
        pdf, width, height, "TAX CREDIT NOTE",
        marker="REFUND", marker_color=_AMBER,
    )
    cursor_y = _party(
        pdf, width, cursor_y, doc_label="Credit note #", number=credit_note.number,
        issued_at=credit_note.issued_at,
        bill_to_name=invoice.bill_to_display, bill_to_email=invoice.bill_to_email, bill_to_trn=invoice.bill_to_trn,
        right_line=f"Against invoice: {invoice.number}",
    )

    # Per-line breakdown when the note fully reverses an invoice tied to a booking —
    # each credited line shows its own discount and VAT. Partial credits keep the
    # single reason line.
    booking = invoice.booking
    lines = []
    if booking is not None and abs(Decimal(credit_note.total) - Decimal(invoice.total)) < Decimal("0.01"):
        from apps.bookings.services import booking_line_breakdown
        lines = booking_line_breakdown(booking, tax_rate=invoice.tax_rate)

    any_incl = any(ln["tax_inclusive"] for ln in lines)
    show_disc = any(Decimal(str(ln["discount"])) > 0 for ln in lines)
    if lines:
        gross_x, disc_x, vat_x = _invoice_cols(width, show_disc)
        cursor_y = _invoice_items_header(pdf, width, cursor_y, show_disc)
        pdf.setFont("Helvetica", 9)
        for ln in lines:
            cursor_y -= 8 * mm
            label = ln["label"] + (" *" if ln["tax_inclusive"] else "")
            pdf.drawString(22 * mm, cursor_y, label[:46])
            _draw_money_right(pdf, gross_x, cursor_y, ln["gross"], credit_note.currency, size=9)
            if disc_x is not None and Decimal(str(ln["discount"])) > 0:
                _draw_money_right(pdf, disc_x, cursor_y, ln["discount"], credit_note.currency, size=9)
            _draw_money_right(pdf, vat_x, cursor_y, ln["tax"], credit_note.currency, size=9)
            _draw_money_right(pdf, width - 22 * mm, cursor_y, ln["total"], credit_note.currency, size=9)
        if credit_note.reason:
            cursor_y -= 8 * mm
            pdf.setFont("Helvetica-Oblique", 9)
            pdf.setFillColor(colors.grey)
            pdf.drawString(22 * mm, cursor_y, f"Reason: {credit_note.reason[:80]}")
            pdf.setFillColor(colors.black)
    else:
        cursor_y = _items_header(pdf, width, cursor_y)
        cursor_y -= 12 * mm
        pdf.setFont("Helvetica", 10)
        desc = credit_note.reason or "Credit against invoice"
        pdf.drawString(22 * mm, cursor_y, desc[:70])
        _draw_money_right(pdf, width - 22 * mm, cursor_y, credit_note.subtotal, credit_note.currency)

    cursor_y -= 14 * mm
    pdf.line(120 * mm, cursor_y + 4 * mm, width - 20 * mm, cursor_y + 4 * mm)

    def total_row(label, amount, bold=False):
        nonlocal cursor_y
        pdf.setFont("Helvetica-Bold" if bold else "Helvetica", 10)
        pdf.drawRightString(150 * mm, cursor_y, label)
        _draw_money_right(pdf, width - 22 * mm, cursor_y, amount, credit_note.currency, bold=bold)
        cursor_y -= 7 * mm

    total_row("Subtotal credited (excl. VAT)", credit_note.subtotal)
    total_row(f"VAT ({credit_note.tax_rate * 100:.0f}%)", credit_note.tax_amount)
    total_row("Total credited", credit_note.total, bold=True)

    if any_incl:
        cursor_y -= 2 * mm
        pdf.setFont("Helvetica-Oblique", 8)
        pdf.setFillColor(colors.grey)
        pdf.drawString(22 * mm, cursor_y, "* Price is VAT-inclusive - the VAT shown is the portion contained in it.")
        pdf.setFillColor(colors.black)

    method = (credit_note.method or "").replace("_", " ").title()
    refund_line = None
    if credit_note.refund_id:
        refund_line = f"Refunded via {method or 'payment'} ({credit_note.refund.payment.reference})"
    elif method:
        refund_line = f"Refunded via {method}"
    if refund_line:
        cursor_y -= 3 * mm
        pdf.setFont("Helvetica-Oblique", 9)
        pdf.setFillColor(colors.grey)
        pdf.drawRightString(width - 22 * mm, cursor_y, refund_line)
        pdf.setFillColor(colors.black)

    _footer(pdf, width, "This credit note reverses the referenced invoice. Computer-generated.")
    return _finish(buffer, pdf)


def build_membership_bytes(membership) -> bytes:
    """Render a membership card: number, plan, validity, entitlements."""
    buffer, pdf, width, height = _new_doc()
    cust = membership.customer
    name = getattr(cust, "full_name", None) or getattr(cust, "email", "") or "Member"
    email = getattr(cust, "email", "") or ""
    cursor_y = _header(pdf, width, height, "MEMBERSHIP")
    cursor_y = _party(
        pdf, width, cursor_y, doc_label="Membership #", number=membership.number or "-",
        issued_at=membership.created_at, bill_to_name=name, bill_to_email=email,
        bill_to_trn="", right_line=f"Plan: {membership.plan.name}")

    cursor_y -= 14 * mm
    pdf.setFont("Helvetica", 10)
    pdf.drawString(20 * mm, cursor_y, f"Status: {membership.get_status_display()}")
    pdf.drawRightString(
        width - 20 * mm, cursor_y,
        f"Valid: {membership.start_date:%d %b %Y} - {membership.end_date:%d %b %Y}")

    cursor_y -= 12 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawString(20 * mm, cursor_y, "Entitlements")
    cursor_y -= 7 * mm
    pdf.setFont("Helvetica", 9.5)
    ents = list(membership.plan.entitlements.all())
    if not ents:
        pdf.drawString(22 * mm, cursor_y, "-")
        cursor_y -= 6 * mm
    for e in ents:
        label = (getattr(e.facility_type, "name", None) or getattr(e.facility_category, "name", None)
                 or getattr(e.addon, "name", None) or "Item")
        limit = "Unlimited" if e.limit_type == "unlimited" else f"{e.quantity} per {e.period}"
        pdf.drawString(22 * mm, cursor_y, f"- {label}: {limit}")
        cursor_y -= 6 * mm

    _footer(pdf, width, "Membership card. Computer-generated.")
    return _finish(buffer, pdf)


def render_invoice_pdf(invoice, *, save=True) -> bytes:
    data = build_invoice_bytes(invoice)
    if save:
        invoice.pdf.save(f"{invoice.number}.pdf", ContentFile(data), save=True)
    return data


def render_receipt_pdf(receipt, *, save=True) -> bytes:
    data = build_receipt_bytes(receipt)
    if save:
        receipt.pdf.save(f"{receipt.number}.pdf", ContentFile(data), save=True)
    return data


def render_credit_note_pdf(credit_note, *, save=True) -> bytes:
    data = build_credit_note_bytes(credit_note)
    if save:
        credit_note.pdf.save(f"{credit_note.number}.pdf", ContentFile(data), save=True)
    return data
