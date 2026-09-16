"""Celery application.

Async is opt-in: with `USE_CELERY=False` (the default) `CELERY_TASK_ALWAYS_EAGER`
is on, so `.delay()` runs the task inline in the calling process — no broker or
worker required (dev/tests run everything synchronously). Set
`USE_CELERY=True` and run a worker (`celery -A config worker -l info`) for real
async processing.
"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("booking_management")
# Pull all CELERY_* settings from Django settings.
app.config_from_object("django.conf:settings", namespace="CELERY")
# Auto-discover tasks.py in every installed app.
app.autodiscover_tasks()
