from django.contrib import admin

from .models import Currency, SystemConfig, TaxRate


@admin.register(Currency)
class CurrencyAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "symbol", "precision", "extended_precision",
                    "minimum_accountable_unit", "rounding_method", "is_active")
    list_filter = ("is_active", "precision", "rounding_method")
    search_fields = ("code", "name")
    list_editable = ("is_active",)


@admin.register(TaxRate)
class TaxRateAdmin(admin.ModelAdmin):
    list_display = ("name", "rate", "country", "is_default")
    list_filter = ("is_default", "country")


@admin.register(SystemConfig)
class SystemConfigAdmin(admin.ModelAdmin):
    list_display = ("key", "description", "updated_at")
    search_fields = ("key", "description")
