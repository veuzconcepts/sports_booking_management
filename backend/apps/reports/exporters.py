"""Excel (openpyxl) and PDF (reportlab) exporters for reports.

Each function returns raw bytes so the view can wrap them in an HttpResponse
with the right content type.
"""

from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Font
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from apps.settings_app.currency import decimals_for, get_default_currency


def _dp() -> int:
    """Decimal places of the active currency (0/2/3) for export formatting."""
    return decimals_for(get_default_currency())


def _money(value, dp=None) -> str:
    """Format a money value to the currency's decimals with thousands separators."""
    dp = _dp() if dp is None else dp
    try:
        return f"{float(value):,.{dp}f}"
    except (TypeError, ValueError):
        return str(value)


def _xlsx_money_format(dp=None) -> str:
    dp = _dp() if dp is None else dp
    return "#,##0" if dp == 0 else "#,##0." + ("0" * dp)


def table_to_xlsx(title: str, subtitle: str, headers: list, rows: list) -> bytes:
    """Generic single-table xlsx. `rows` is a list of tuples (native types)."""
    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=14)
    if subtitle:
        ws["A2"] = subtitle
    header_row = 4
    for c, h in enumerate(headers, start=1):
        ws.cell(row=header_row, column=c, value=h).font = Font(bold=True)
    money_fmt = _xlsx_money_format()
    for i, row in enumerate(rows, start=header_row + 1):
        for c, val in enumerate(row, start=1):
            cell = ws.cell(row=i, column=c, value=val)
            if isinstance(val, float):   # money columns -> currency decimals
                cell.number_format = money_fmt
    for c in range(1, len(headers) + 1):
        ws.column_dimensions[chr(64 + c)].width = 24
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def table_to_pdf(title: str, subtitle: str, headers: list, rows: list) -> bytes:
    """Generic single-table PDF: first column left-aligned, rest right-aligned."""
    buf = BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    left, right = 20 * mm, width - 20 * mm
    n = len(headers)

    def xpos(i):  # right edge for numeric columns
        return right - (n - 1 - i) * 40 * mm

    def fmt(v):
        return _money(v) if isinstance(v, float) else str(v)

    y = [height - 25 * mm]
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(left, y[0], title)
    y[0] -= 8 * mm
    if subtitle:
        pdf.setFont("Helvetica", 10)
        pdf.setFillColor(colors.grey)
        pdf.drawString(left, y[0], subtitle)
        pdf.setFillColor(colors.black)
    y[0] -= 12 * mm

    def header():
        pdf.setFillColor(colors.HexColor("#0f172a"))
        pdf.rect(left, y[0] - 2 * mm, right - left, 8 * mm, fill=1, stroke=0)
        pdf.setFillColor(colors.white)
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawString(left + 2 * mm, y[0], str(headers[0]))
        for i in range(1, n):
            pdf.drawRightString(xpos(i), y[0], str(headers[i]))
        pdf.setFillColor(colors.black)
        y[0] -= 9 * mm

    header()
    pdf.setFont("Helvetica", 9)
    for row in rows:
        if y[0] < 25 * mm:
            pdf.showPage()
            y[0] = height - 25 * mm
            pdf.setFont("Helvetica-Bold", 9)
            header()
            pdf.setFont("Helvetica", 9)
        pdf.drawString(left + 2 * mm, y[0], fmt(row[0]))
        for i in range(1, n):
            pdf.drawRightString(xpos(i), y[0], fmt(row[i]))
        y[0] -= 6 * mm

    pdf.showPage()
    pdf.save()
    return buf.getvalue()


def revenue_to_xlsx(report: dict) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Revenue"

    ws["A1"] = "Revenue report"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = f"{report['date_from']} → {report['date_to']}"
    money_fmt = _xlsx_money_format()
    ws["A4"] = "Gross"
    ws["B4"] = float(report["gross_revenue"]); ws["B4"].number_format = money_fmt
    ws["A5"] = "Refunded"
    ws["B5"] = float(report["refunded"]); ws["B5"].number_format = money_fmt
    ws["A6"] = "Net"
    ws["B6"] = float(report["net_revenue"]); ws["B6"].number_format = money_fmt
    ws["A6"].font = ws["B6"].font = Font(bold=True)

    header_row = 8
    ws.cell(row=header_row, column=1, value="Date").font = Font(bold=True)
    ws.cell(row=header_row, column=2, value="Gross").font = Font(bold=True)
    ws.cell(row=header_row, column=3, value="Net").font = Font(bold=True)
    for i, row in enumerate(report["series"], start=header_row + 1):
        ws.cell(row=i, column=1, value=row["date"])
        g = ws.cell(row=i, column=2, value=float(row["gross"])); g.number_format = money_fmt
        nt = ws.cell(row=i, column=3, value=float(row["net"])); nt.number_format = money_fmt

    for col in ("A", "B", "C"):
        ws.column_dimensions[col].width = 16

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def revenue_to_pdf(report: dict) -> bytes:
    buf = BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    y = height - 25 * mm

    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(20 * mm, y, "Revenue Report")
    y -= 8 * mm
    pdf.setFont("Helvetica", 10)
    pdf.setFillColor(colors.grey)
    pdf.drawString(20 * mm, y, f"{report['date_from']} to {report['date_to']}")
    pdf.setFillColor(colors.black)

    y -= 14 * mm
    for label, key, bold in [("Gross revenue", "gross_revenue", False),
                             ("Refunded", "refunded", False),
                             ("Net revenue", "net_revenue", True)]:
        pdf.setFont("Helvetica-Bold" if bold else "Helvetica", 11)
        pdf.drawString(22 * mm, y, label)
        pdf.drawRightString(120 * mm, y, _money(report[key]))
        y -= 7 * mm

    y -= 6 * mm
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.rect(20 * mm, y - 2 * mm, 100 * mm, 8 * mm, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(22 * mm, y, "Date")
    pdf.drawRightString(118 * mm, y, "Net")
    pdf.setFillColor(colors.black)
    y -= 9 * mm

    pdf.setFont("Helvetica", 9)
    for row in report["series"]:
        if y < 25 * mm:
            pdf.showPage()
            y = height - 25 * mm
            pdf.setFont("Helvetica", 9)
        pdf.drawString(22 * mm, y, row["date"])
        pdf.drawRightString(118 * mm, y, _money(row["net"]))
        y -= 6 * mm

    pdf.showPage()
    pdf.save()
    return buf.getvalue()
