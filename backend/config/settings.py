"""
Django settings for the Club & Facility Booking Management System.

Driven entirely by environment variables — see `.env.example` for the full list.
"""

from datetime import timedelta
from pathlib import Path

from celery.schedules import crontab
from decouple import Csv, config

BASE_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
SECRET_KEY = config("DJANGO_SECRET_KEY", default="dev-insecure-secret-change-me")
DEBUG = config("DJANGO_DEBUG", default=True, cast=bool)
ALLOWED_HOSTS = config("DJANGO_ALLOWED_HOSTS", default="*", cast=Csv())

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------
DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    "drf_spectacular",
]

LOCAL_APPS = [
    "apps.accounts",
    "apps.customers",
    "apps.clubs",
    "apps.facilities",
    "apps.bookings",
    "apps.staff",
    "apps.payments",
    "apps.reports",
    "apps.settings_app",
    "apps.notifications",
    "apps.auditlogs",
    "apps.promotions",
    "apps.customer_auth",
    "apps.website",
    "apps.loyalty",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "config.security_headers.SecurityHeadersMiddleware",
    "apps.auditlogs.middleware.AuditLogMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ---------------------------------------------------------------------------
# Database — PostgreSQL by default, fall back to sqlite for first-run sanity
# ---------------------------------------------------------------------------
# Accept short engine aliases in .env (e.g. DB_ENGINE=postgresql) as well as
# full dotted paths (django.db.backends.postgresql).
_DB_ENGINE_ALIASES = {
    "postgresql": "django.db.backends.postgresql",
    "postgres": "django.db.backends.postgresql",
    "mysql": "django.db.backends.mysql",
    "sqlite3": "django.db.backends.sqlite3",
    "sqlite": "django.db.backends.sqlite3",
}
_db_engine = config("DB_ENGINE", default="django.db.backends.postgresql")
_db_engine = _DB_ENGINE_ALIASES.get(_db_engine, _db_engine)

DATABASES = {
    "default": {
        "ENGINE": _db_engine,
        "NAME": config("DB_NAME", default="booking_management"),
        "USER": config("DB_USER", default="postgres"),
        "PASSWORD": config("DB_PASSWORD", default=""),
        "HOST": config("DB_HOST", default="127.0.0.1"),
        "PORT": config("DB_PORT", default="5432"),
    }
}

if config("USE_SQLITE", default=False, cast=bool):
    DATABASES["default"] = {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": config("PASSWORD_MIN_LENGTH", default=10, cast=int)}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    # Require a mix of character classes (upper, lower, digit, symbol).
    {"NAME": "apps.accounts.validators.PasswordComplexityValidator"},
]

# ---------------------------------------------------------------------------
# Internationalisation
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static / Media
# ---------------------------------------------------------------------------
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# DRF + JWT + Spectacular
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        # Reads the JWT from an HttpOnly cookie (and enforces CSRF for cookie
        # auth); still accepts `Authorization: Bearer` for non-browser clients.
        "apps.accounts.authentication.CookieJWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
    ),
    # Professional, non-technical wording for framework-default errors
    # (e.g. the generic "No <Model> matches the given query." 404).
    "EXCEPTION_HANDLER": "config.drf.api_exception_handler",
    "DEFAULT_FILTER_BACKENDS": (
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ),
    # One pagination standard for every list endpoint, so the admin table's
    # page-size control works everywhere rather than only on Users.
    "DEFAULT_PAGINATION_CLASS": "config.listing.StandardPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    # Throttling — brute-force protection on auth endpoints and general abuse.
    "DEFAULT_THROTTLE_CLASSES": (
        "rest_framework.throttling.ScopedRateThrottle",
    ),
    "DEFAULT_THROTTLE_RATES": {
        "login": config("THROTTLE_LOGIN", default="10/min"),
        "mfa": config("THROTTLE_MFA", default="10/min"),
        "register": config("THROTTLE_REGISTER", default="5/min"),
        "password": config("THROTTLE_PASSWORD", default="5/min"),
        "customer_auth": config("THROTTLE_CUSTOMER_AUTH", default="6/min"),
        # Public website booking creation — limit abuse / mass-booking from one IP.
        "public_booking": config("THROTTLE_PUBLIC_BOOKING", default="12/hour"),
    },
    # Throttle client identity: number of trusted proxies in front of the app.
    # 0 (default) = key on REMOTE_ADDR and IGNORE X-Forwarded-For, so a client
    # cannot spoof XFF to dodge the login/mfa throttle. Behind a reverse proxy
    # or load balancer, set NUM_PROXIES to the real hop count so the throttle
    # keys on the genuine client IP (the Nth-from-last XFF entry).
    "NUM_PROXIES": config("NUM_PROXIES", default=0, cast=int),
}

# Throttle/lockout state lives in the cache. LocMem is per-process (fine for a
# single dev server); set USE_REDIS_CACHE=True in production for a shared store.
if config("USE_REDIS_CACHE", default=False, cast=bool):
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": config("CACHE_REDIS_URL", default=config("REDIS_URL", default="redis://127.0.0.1:6379/2")),
        }
    }
else:
    CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }

# Account lockout policy (credential failures).
LOGIN_MAX_FAILURES = config("LOGIN_MAX_FAILURES", default=5, cast=int)
LOGIN_LOCKOUT_SECONDS = config("LOGIN_LOCKOUT_SECONDS", default=900, cast=int)  # 15 min

# Roles for which MFA enrolment is mandatory. EMPTY by default — MFA is optional
# (self-service) until you choose to enforce it. To enforce, set e.g.
# MFA_REQUIRED_ROLES=super_admin,admin in the environment. A user in a required
# role who has not enrolled is allowed to authenticate but gated to the
# MFA-enrolment allowlist until they enrol (enforced in CookieJWTAuthentication).
# Per-login OTP verification for already-enrolled users is unaffected by this.
MFA_REQUIRED_ROLES = {
    r.strip()
    for r in config("MFA_REQUIRED_ROLES", default="").split(",")
    if r.strip()
}

# Dedicated JWT signing key, sourced from the environment (.env) and kept
# separate from Django's SECRET_KEY so the two can be rotated independently.
# Falls back to SECRET_KEY only if JWT_SIGNING_KEY is unset.
JWT_SIGNING_KEY = config("JWT_SIGNING_KEY", default=SECRET_KEY)

SIMPLE_JWT = {
    "ALGORITHM": "HS256",
    "SIGNING_KEY": JWT_SIGNING_KEY,
    "ACCESS_TOKEN_LIFETIME":
        timedelta(minutes=config("JWT_ACCESS_MINUTES", default=60, cast=int)),
    "REFRESH_TOKEN_LIFETIME":
        timedelta(days=config("JWT_REFRESH_DAYS", default=7, cast=int)),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# ---------------------------------------------------------------------------
# Auth cookies — JWTs are delivered as HttpOnly cookies (never readable by JS,
# so XSS cannot exfiltrate them). CSRF protects cookie-authenticated writes.
# ---------------------------------------------------------------------------
AUTH_COOKIE_ACCESS = "cfb_access"
AUTH_COOKIE_REFRESH = "cfb_refresh"
AUTH_COOKIE_DOMAIN = config("AUTH_COOKIE_DOMAIN", default=None) or None
AUTH_COOKIE_SAMESITE = config("AUTH_COOKIE_SAMESITE", default="Lax")
# Secure cookies in production (requires HTTPS); off in DEBUG so http://localhost works.
AUTH_COOKIE_SECURE = config("AUTH_COOKIE_SECURE", default=not DEBUG, cast=bool)
# Refresh cookie is scoped to the auth routes so it isn't sent on every request.
AUTH_COOKIE_REFRESH_PATH = "/api/v1/auth/"

# Opaque server-side sessions for the browser cookie path: when True the auth
# cookies carry a random handle and the JWT is held server-side (cache), so a JWT
# never reaches the browser. The Authorization: Bearer path (API clients) is
# unaffected.
# Requires a shared, persistent, non-evicting cache in production (USE_REDIS_CACHE)
# - see apps/accounts/session_store.py. Default off for a safe, opt-in rollout.
USE_OPAQUE_SESSIONS = config("USE_OPAQUE_SESSIONS", default=False, cast=bool)

# CSRF — the SPA reads the (non-HttpOnly) csrftoken cookie and echoes it back in
# the X-CSRFToken header. Trust the dashboard origin(s).
CSRF_TRUSTED_ORIGINS = config(
    "CSRF_TRUSTED_ORIGINS",
    default="http://localhost:5173,http://127.0.0.1:5173,http://localhost:5175",
    cast=Csv(),
)
CSRF_COOKIE_HTTPONLY = False

SPECTACULAR_SETTINGS = {
    "TITLE": "Club & Facility Booking Management API",
    "DESCRIPTION": "Booking, availability and administration for clubs and their facilities.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    # The API docs (schema / Swagger / Redoc) expose the full endpoint map, so
    # they are NOT public — only a signed-in Super Admin may view them.
    "SERVE_PERMISSIONS": ["apps.accounts.permissions.IsSuperAdmin"],
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = config(
    "CORS_ALLOWED_ORIGINS",
    default="http://localhost:5173,http://127.0.0.1:5173",
    cast=Csv(),
)
CORS_ALLOW_CREDENTIALS = True

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------
EMAIL_BACKEND = config(
    "EMAIL_BACKEND",
    default="django.core.mail.backends.console.EmailBackend",
)
DEFAULT_FROM_EMAIL = config(
    "DEFAULT_FROM_EMAIL",
    default="no-reply@example.com",
)

# ---------------------------------------------------------------------------
# Celery / Redis
# ---------------------------------------------------------------------------
REDIS_URL = config("REDIS_URL", default="redis://127.0.0.1:6379/0")
CELERY_BROKER_URL = config("CELERY_BROKER_URL", default=REDIS_URL)
CELERY_RESULT_BACKEND = config("CELERY_RESULT_BACKEND", default=REDIS_URL)
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = TIME_ZONE
# Opt-in async: with USE_CELERY=False (default) tasks run EAGERLY (inline, in the
# calling process) — no broker or worker needed for dev/tests, behaviour matches
# the old synchronous code. Set USE_CELERY=True + run a worker for real async.
USE_CELERY = config("USE_CELERY", default=False, cast=bool)
CELERY_TASK_ALWAYS_EAGER = not USE_CELERY
CELERY_TASK_EAGER_PROPAGATES = True
# --- Reliability (real async / production) ---------------------------------
# Ack only after the task finishes, and requeue if a worker dies mid-task, so an
# invoice-PDF / notification is never silently lost on a crash.
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
# One task at a time per worker process — fair dispatch for these I/O-bound jobs.
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_WORKER_MAX_TASKS_PER_CHILD = 200          # recycle workers to cap memory
CELERY_TASK_SOFT_TIME_LIMIT = 60                 # raise inside the task at 60s
CELERY_TASK_TIME_LIMIT = 90                      # hard kill at 90s
CELERY_RESULT_EXPIRES = 3600                     # drop stored results after 1h
# Keep retrying the broker connection on worker startup (Celery 6 default).
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
# --- Periodic jobs (Celery Beat) -------------------------------------------
# Daily backstops for the two lazily-activated lifecycle jobs. Both also run on
# demand (`manage.py expire_memberships` / `activate_due_transfers`) and lazily
# on the relevant list/detail load, so missing a beat tick never loses state.
# Run the scheduler with `celery -A config beat` (the `beat` Procfile process)
# when USE_CELERY=True; under the eager default these tasks just don't fire.
CELERY_BEAT_SCHEDULE = {
    "expire-memberships-daily": {
        "task": "apps.payments.tasks.expire_memberships_task",
        "schedule": crontab(hour=0, minute=15),
    },
    "activate-due-transfers-daily": {
        "task": "apps.staff.tasks.activate_due_transfers_task",
        "schedule": crontab(hour=0, minute=20),
    },
    # Split deadlines are measured in minutes, so this cannot wait for a nightly
    # sweep the way membership expiry can.
    "expire-split-payments": {
        "task": "apps.payments.tasks.expire_split_payments_task",
        "schedule": crontab(minute="*/5"),
    },
}

# ---------------------------------------------------------------------------
# Business defaults
# ---------------------------------------------------------------------------
DEFAULT_CURRENCY = config("DEFAULT_CURRENCY", default="USD")
DEFAULT_TAX_RATE = config("DEFAULT_TAX_RATE", default=0.05, cast=float)

# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------
# Which payment provider actually takes card money. One setting, read in one
# place (apps.payments.gateway.get_gateway); no component branches on it.
#
#   demo     - simulated card authorisation for testing the real booking
#              lifecycle end to end. Test cards only, no money moves.
#   live     - a real provider adapter (none is integrated yet).
#   disabled - card payment is unavailable; the checkout offers cash only.
#
# Demo is deliberately hard to switch on by accident: it is permitted when
# DJANGO_DEBUG is on, or when a sandbox/staging host opts in EXPLICITLY with
# PAYMENT_ALLOW_DEMO=true. A production box that is left on PAYMENT_MODE=demo
# resolves to `disabled` and refuses card payment rather than pretending a
# charge succeeded - failing closed is the only safe direction for money.
PAYMENT_MODE = config("PAYMENT_MODE", default="demo" if DEBUG else "disabled")
PAYMENT_ALLOW_DEMO = DEBUG or config("PAYMENT_ALLOW_DEMO", default=False, cast=bool)

# How long an unpaid split-payment arrangement stays open. The booking itself
# is NOT a separate hold (a pending booking already occupies its slot), so this
# only governs how long the shareable links keep working.
SPLIT_PAYMENT_MINUTES = config("SPLIT_PAYMENT_MINUTES", default=60, cast=int)
# Upper bound on how many people one booking may be split between.
SPLIT_PAYMENT_MAX_SHARES = config("SPLIT_PAYMENT_MAX_SHARES", default=20, cast=int)
# Public base URL used to build shareable payment links (the customer website).
PUBLIC_WEBSITE_URL = config("PUBLIC_WEBSITE_URL", default="http://localhost:4321")

# Google Maps / Places / Geocoding — environment-driven, never hardcoded. The
# frontend uses VITE_GOOGLE_MAPS_API_KEY (Maps JS + Places) to place clubs on a
# map. These server-side keys are placeholders for future server-side geocoding.
GOOGLE_MAPS_API_KEY = config("GOOGLE_MAPS_API_KEY", default="")
GOOGLE_PLACES_API_KEY = config("GOOGLE_PLACES_API_KEY", default="")
GOOGLE_GEOCODING_API_KEY = config("GOOGLE_GEOCODING_API_KEY", default="")

# ---------------------------------------------------------------------------
# AI reporting assistant
# ---------------------------------------------------------------------------
# The key is server-side only and is never sent to the browser or logged. The
# assistant is read-only by construction (see apps/reports/ai/tools.py); these
# settings control cost, latency and blast radius, not what it is allowed to do.
AI_PROVIDER = config("AI_PROVIDER", default="openai")
OPENAI_API_KEY = config("OPENAI_API_KEY", default="")
OPENAI_BASE_URL = config("OPENAI_BASE_URL", default="https://api.openai.com/v1")
OPENAI_MODEL = config("OPENAI_MODEL", default="gpt-4o-mini")
# Reporting uses its own model setting so it can be tuned without touching any
# other AI feature that may be added later.
OPENAI_REPORT_MODEL = config("OPENAI_REPORT_MODEL", default=OPENAI_MODEL)

AI_REQUEST_TIMEOUT_SECONDS = config("AI_REQUEST_TIMEOUT_SECONDS", default=30, cast=int)
AI_MAX_RETRIES = config("AI_MAX_RETRIES", default=1, cast=int)
AI_MAX_OUTPUT_TOKENS = config("AI_MAX_OUTPUT_TOKENS", default=1200, cast=int)

# A master switch: off means the Reports page simply does not offer the panel,
# and the endpoints refuse politely. Normal reports are unaffected either way.
AI_REPORT_ENABLED = config("AI_REPORT_ENABLED", default=True, cast=bool)
AI_REPORT_CACHE_TTL_SECONDS = config("AI_REPORT_CACHE_TTL_SECONDS", default=900, cast=int)
# Guard rails against a question that would scan years of data or return a
# table nobody can read.
AI_REPORT_MAX_DATE_RANGE_DAYS = config("AI_REPORT_MAX_DATE_RANGE_DAYS", default=732, cast=int)
AI_REPORT_MAX_ROWS = config("AI_REPORT_MAX_ROWS", default=500, cast=int)
AI_CHAT_HISTORY_MAX_MESSAGES = config("AI_CHAT_HISTORY_MAX_MESSAGES", default=10, cast=int)
AI_CHAT_SESSION_TTL_SECONDS = config("AI_CHAT_SESSION_TTL_SECONDS", default=3600, cast=int)

# ---------------------------------------------------------------------------
# Security hardening
# ---------------------------------------------------------------------------
# Applied everywhere (cheap, no downside in dev).
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
X_FRAME_OPTIONS = "DENY"

# Response security headers (see config.security_headers.SecurityHeadersMiddleware).
# Django serves only JSON APIs + the internal admin/API-docs HTML; the admin SPA
# and ITS (Google-Maps-tuned) CSP are served by the reverse proxy (deploy/nginx.conf).
# So the CSP below is a strict API baseline applied to NON-HTML responses only.
# Set CSP_REPORT_ONLY=True to roll out in monitor mode before enforcing.
CSP_REPORT_ONLY = config("CSP_REPORT_ONLY", default=False, cast=bool)
API_CONTENT_SECURITY_POLICY = config(
    "API_CONTENT_SECURITY_POLICY",
    default="default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
)
PERMISSIONS_POLICY = config(
    "PERMISSIONS_POLICY",
    default=(
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), "
        "encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), midi=(), payment=(), usb=()"
    ),
)

if not DEBUG:
    # Fail fast rather than ship insecure defaults to production.
    from django.core.exceptions import ImproperlyConfigured

    _INSECURE_KEYS = (
        "dev-insecure-secret-change-me", "local-dev-secret-change-me",
        "change-me-in-production-please", "change-me-jwt-signing-key",
        "test", "test-secret", "",
    )
    if SECRET_KEY in _INSECURE_KEYS:
        raise ImproperlyConfigured(
            "DJANGO_SECRET_KEY is unset or using an insecure default. "
            "Set a strong, unique secret in production."
        )
    if JWT_SIGNING_KEY in _INSECURE_KEYS:
        raise ImproperlyConfigured(
            "JWT_SIGNING_KEY is unset or using an insecure default. "
            "Set a strong, unique JWT signing key in production."
        )
    if "*" in ALLOWED_HOSTS:
        raise ImproperlyConfigured(
            "ALLOWED_HOSTS must not contain '*' in production. "
            "List your real hostnames in DJANGO_ALLOWED_HOSTS."
        )

    SECURE_HSTS_SECONDS = 60 * 60 * 24 * 365  # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    # Trust the X-Forwarded-Proto header from a TLS-terminating proxy/load balancer.
    if config("BEHIND_TLS_PROXY", default=False, cast=bool):
        SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
