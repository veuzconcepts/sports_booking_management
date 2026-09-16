"""Gunicorn production config for the Django API.

The app is HTTP-only (no WebSockets/Channels in use), so plain sync workers on
the WSGI app are the simplest, most robust choice. Bind to localhost only - nginx
(deploy/nginx.conf) is the sole public entry point and proxies /api here.

Run:  gunicorn -c deploy/gunicorn.conf.py config.wsgi:application
      (working directory = the `backend/` folder)

Tunables are env-overridable so the systemd unit / .env can size per box.
"""

import multiprocessing
import os

# Localhost only: Django is never publicly routable; nginx proxies to it.
bind = os.environ.get("GUNICORN_BIND", "127.0.0.1:8000")

# 2*CPU+1 is the standard starting point for sync workers; override on small boxes.
workers = int(os.environ.get("GUNICORN_WORKERS", multiprocessing.cpu_count() * 2 + 1))

# A couple of threads per worker helps with the app's IO-bound calls (DB, Redis,
# email/PDF hand-off) without the memory cost of extra processes.
threads = int(os.environ.get("GUNICORN_THREADS", 2))

worker_class = "gthread"

# Recycle workers periodically to cap any slow memory growth (jitter avoids all
# workers restarting at once).
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", 1000))
max_requests_jitter = int(os.environ.get("GUNICORN_MAX_REQUESTS_JITTER", 100))

timeout = int(os.environ.get("GUNICORN_TIMEOUT", 60))
graceful_timeout = 30
keepalive = 5

# Trust the reverse proxy on localhost for X-Forwarded-* (pair with Django
# BEHIND_TLS_PROXY=True + NUM_PROXIES=1).
forwarded_allow_ips = os.environ.get("GUNICORN_FORWARDED_ALLOW_IPS", "127.0.0.1")

# Log to stdout/stderr so journald captures everything.
accesslog = "-"
errorlog = "-"
loglevel = os.environ.get("GUNICORN_LOGLEVEL", "info")
# Include the real client IP (forwarded by nginx) in the access log.
access_log_format = '%({x-forwarded-for}i)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)sus'

proc_name = "clubbooking-web"
