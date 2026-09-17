# ASGI web server (Channels/daphne) + the Celery worker for real async tasks +
# the Celery beat scheduler for periodic jobs (membership expiry, due transfers).
# Set USE_CELERY=True and REDIS_URL (broker) in the environment for worker+beat.
web: cd backend && daphne -b 0.0.0.0 -p ${PORT:-8000} config.asgi:application
worker: cd backend && celery -A config worker -l info --concurrency=${CELERY_CONCURRENCY:-4}
beat: cd backend && celery -A config beat -l info
