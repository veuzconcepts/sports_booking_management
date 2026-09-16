from django.contrib import admin

from .models import Address, Customer, LoyaltyLedger


class AddressInline(admin.TabularInline):
    model = Address
    extra = 0


@admin.register(Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ("customer_code", "full_name", "email", "loyalty_tier",
                    "loyalty_points", "lifetime_value", "is_corporate", "member_since")
    list_filter = ("loyalty_tier", "is_corporate", "source", "customer_type", "status")
    search_fields = ("full_name", "email", "mobile_number", "customer_code")
    inlines = [AddressInline]
    raw_id_fields = ("linked_user",)


@admin.register(Address)
class AddressAdmin(admin.ModelAdmin):
    list_display = ("customer", "label", "line1", "city", "is_default")
    list_filter = ("label", "is_default", "city")
    search_fields = ("line1", "city", "customer__email")


@admin.register(LoyaltyLedger)
class LoyaltyLedgerAdmin(admin.ModelAdmin):
    list_display = ("customer", "txn_type", "points", "note", "created_at")
    list_filter = ("txn_type",)
    search_fields = ("customer__email",)
    readonly_fields = ("created_at",)
