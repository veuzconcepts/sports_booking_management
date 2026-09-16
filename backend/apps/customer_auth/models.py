"""One-time passcodes for customer mobile-app auth (phone / email).

Codes are stored hashed (never plaintext), single-use, time-limited, and
attempt-capped. This is the customer side only — fully separate from staff/admin
login. There is no customer web portal.
"""

from django.contrib.auth.hashers import check_password
from django.db import models
from django.utils import timezone

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
OTP_LENGTH = 6


class OtpChannel(models.TextChoices):
    PHONE = "phone", "Phone"
    EMAIL = "email", "Email"


class OtpCode(models.Model):
    channel = models.CharField(max_length=10, choices=OtpChannel.choices)
    identifier = models.CharField(max_length=120, db_index=True)  # phone or lowercased email
    code_hash = models.CharField(max_length=128)
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["channel", "identifier", "-created_at"])]

    def __str__(self):
        return f"OTP({self.channel}:{self.identifier})"

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    def check_code(self, raw: str) -> bool:
        return check_password(raw, self.code_hash)
