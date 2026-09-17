from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.accounts"
    label = "accounts"
    verbose_name = "Accounts & Authentication"

    def ready(self):
        # Registers the drf-spectacular auth extension so the API docs know how
        # callers authenticate (Bearer JWT / HttpOnly cookie). Import side-effect
        # only - no runtime auth behaviour changes.
        from . import schema  # noqa: F401
