"""Custom password validators."""

import re

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _


class PasswordComplexityValidator:
    """Require a mix of character classes: lower, upper, digit, and symbol."""

    def validate(self, password, user=None):
        checks = {
            "lowercase letter": r"[a-z]",
            "uppercase letter": r"[A-Z]",
            "digit": r"\d",
            "symbol": r"[^\w\s]",
        }
        missing = [label for label, pattern in checks.items() if not re.search(pattern, password)]
        if missing:
            raise ValidationError(
                _("Password must contain at least one %(missing)s.")
                % {"missing": ", one ".join(missing)},
                code="password_not_complex",
            )

    def get_help_text(self):
        return _(
            "Your password must include upper- and lower-case letters, "
            "a digit, and a symbol."
        )
