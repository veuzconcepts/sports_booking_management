from django.apps import AppConfig


class SettingsAppConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.settings_app"
    label = "settings_app"

    def ready(self):
        from django.db.models.signals import post_delete, post_save

        from . import currency
        from .models import Currency

        def _invalidate(sender, **kwargs):
            currency.invalidate_currency_cache()

        post_save.connect(_invalidate, sender=Currency, dispatch_uid="currency_cache_save")
        post_delete.connect(_invalidate, sender=Currency, dispatch_uid="currency_cache_delete")
