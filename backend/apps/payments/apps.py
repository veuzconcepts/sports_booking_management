from django.apps import AppConfig
from django.conf import settings
from django.core.checks import Error, register


class PaymentsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.payments"
    label = "payments"

    def ready(self):
        register(check_public_website_url, "deploy")


def check_public_website_url(app_configs, **kwargs):
    """`manage.py check --deploy` refuses a server that would issue dead links.

    Every split payment link is built from `PUBLIC_WEBSITE_URL`, which defaults
    to localhost so a developer needs no configuration. Left unset on a server
    the links are issued, copied into a group chat and never resolve, while the
    court stays held and nobody can pay for it.

    `split._site_base` already refuses to create the arrangement in that state,
    so the customer is never handed a dead link. This is the earlier warning:
    the deploy runs `check --deploy` (see deploy/DEPLOYMENT.md), and finding it
    there costs nothing, whereas finding it later costs a booking.
    """
    from .split import site_url_configured

    if settings.DEBUG:
        return []
    base = getattr(settings, "PUBLIC_WEBSITE_URL", "")
    if site_url_configured(base):
        return []
    return [Error(
        "PUBLIC_WEBSITE_URL is unset or points at localhost, so split payment "
        f"links would not resolve for anyone (currently {base or 'unset'!r}). "
        "Set it to the public address of the customer website, "
        "e.g. PUBLIC_WEBSITE_URL=https://www.example.com",
        id="payments.E001",
    )]
