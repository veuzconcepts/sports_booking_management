from django.contrib import admin

from .models import (
    CreditNote,
    Invoice,
    Membership,
    MembershipPlan,
    Payment,
    Receipt,
    Refund,
    Wallet,
    WalletTxn,
)


class WalletTxnInline(admin.TabularInline):
    model = WalletTxn
    extra = 0
    readonly_fields = ("txn_type", "amount", "balance_after", "note", "created_at")
    can_delete = False


@admin.register(Wallet)
class WalletAdmin(admin.ModelAdmin):
    list_display = ("customer", "balance", "currency", "updated_at")
    search_fields = ("customer__email",)
    raw_id_fields = ("customer",)
    inlines = [WalletTxnInline]


class RefundInline(admin.TabularInline):
    model = Refund
    extra = 0
    readonly_fields = ("amount", "reason", "created_by", "created_at")


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = ("reference", "customer", "method", "status",
                    "amount", "refunded_amount", "created_at")
    list_filter = ("status", "method", "gateway")
    search_fields = ("reference", "customer__email", "booking__reference")
    raw_id_fields = ("customer", "booking", "created_by")
    readonly_fields = ("reference", "paid_at", "created_at", "updated_at")
    inlines = [RefundInline]


@admin.register(MembershipPlan)
class MembershipPlanAdmin(admin.ModelAdmin):
    list_display = ("name", "interval", "price", "is_group", "is_active")
    list_filter = ("interval", "is_group", "is_active")
    search_fields = ("name",)


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("customer", "plan", "status", "start_date", "end_date",
                    "auto_renew")
    list_filter = ("status", "auto_renew", "plan")
    search_fields = ("customer__email", "plan__name")
    raw_id_fields = ("customer", "plan")


@admin.register(Invoice)
class InvoiceAdmin(admin.ModelAdmin):
    list_display = ("number", "customer", "total", "currency", "issued_at")
    search_fields = ("number", "customer__email")
    raw_id_fields = ("customer", "payment", "booking")
    readonly_fields = ("number", "issued_at")


@admin.register(Refund)
class RefundAdmin(admin.ModelAdmin):
    list_display = ("payment", "amount", "reason", "created_at")
    search_fields = ("payment__reference",)


@admin.register(Receipt)
class ReceiptAdmin(admin.ModelAdmin):
    list_display = ("number", "invoice", "customer", "amount", "currency", "issued_at")
    search_fields = ("number", "invoice__number", "customer__email")
    raw_id_fields = ("customer", "invoice", "payment")
    readonly_fields = ("number", "issued_at")


@admin.register(CreditNote)
class CreditNoteAdmin(admin.ModelAdmin):
    list_display = ("number", "invoice", "customer", "total", "currency", "issued_at")
    search_fields = ("number", "invoice__number", "customer__email")
    raw_id_fields = ("customer", "invoice", "refund")
    readonly_fields = ("number", "issued_at")
