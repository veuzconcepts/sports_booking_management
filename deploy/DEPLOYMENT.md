# Production Deployment (single VPS, systemd + nginx)

Optimized single-server layout for the Club & Facility Booking platform. All app processes bind
to localhost; **nginx is the only public entry point**. Django and the Astro SSR
node are never publicly routable.

```
admin.example.com ─HTTPS─▶ nginx ─▶ /opt/clubbooking/frontend/dist (SPA)
                                  └▶ /api → gunicorn 127.0.0.1:8000 (Django)
www.example.com   ─HTTPS─▶ nginx ─▶ Astro SSR node 127.0.0.1:4321
                                     └─(server-side)→ Django /website/public/*
background:  clubbooking-worker (Celery) + clubbooking-beat  ─▶ Redis ─▶ Postgres
```

Recommended box: **4 vCPU / 8 GB**. Split PostgreSQL to a managed instance as you grow.

---

## 1. System packages

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3-pip \
  postgresql redis-server nginx git curl
# Node 20 LTS for the Astro website:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2. Service user + code

```bash
sudo useradd --system --create-home --shell /bin/bash clubbooking
sudo mkdir -p /opt/clubbooking && sudo chown clubbooking:clubbooking /opt/clubbooking
sudo -u clubbooking git clone <REPO_URL> /opt/clubbooking
```

## 3. PostgreSQL

```bash
sudo -u postgres psql -c "CREATE USER clubbooking WITH PASSWORD 'STRONG_PW';"
sudo -u postgres psql -c "CREATE DATABASE booking_management OWNER clubbooking;"
```

## 4. Redis

Enable a shared cache/broker. If you turn on `USE_OPAQUE_SESSIONS`, sessions live
in Redis - use a TTL-friendly eviction policy so live sessions aren't dropped:

```bash
# /etc/redis/redis.conf
maxmemory 512mb
maxmemory-policy volatile-ttl
sudo systemctl enable --now redis-server
```

## 5. Backend (Django) — as the `clubbooking` user

```bash
cd /opt/clubbooking
python3.12 -m venv venv
./venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env      # then edit — see section 8
cd backend
../venv/bin/python manage.py migrate
../venv/bin/python manage.py collectstatic --noinput
../venv/bin/python manage.py createsuperuser
```

## 6. Frontends — build in place

```bash
# Admin SPA (static). Set VITE_GOOGLE_MAPS_API_KEY in frontend/.env first.
cd /opt/clubbooking/frontend && npm ci && npm run build      # -> frontend/dist

# Public website (Astro SSR)
cd /opt/clubbooking/web && npm ci && npm run build           # -> web/dist/server/entry.mjs
```

## 7. systemd services

```bash
sudo cp /opt/clubbooking/deploy/systemd/clubbooking-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clubbooking-web clubbooking-worker clubbooking-beat clubbooking-website
sudo systemctl status clubbooking-web         # verify each is active
```

## 8. Production `.env` (backend/.env) — the must-set values

```ini
DJANGO_DEBUG=False
DJANGO_ALLOWED_HOSTS=admin.example.com,www.example.com
DJANGO_SECRET_KEY=<50+ char unique>       # boot guard refuses insecure defaults
JWT_SIGNING_KEY=<unique, separate>
DB_ENGINE=postgresql
DB_NAME=booking_management
DB_USER=clubbooking
DB_PASSWORD=STRONG_PW
DB_HOST=127.0.0.1
BEHIND_TLS_PROXY=True
NUM_PROXIES=1
CSRF_TRUSTED_ORIGINS=https://admin.example.com
USE_REDIS_CACHE=True
REDIS_URL=redis://127.0.0.1:6379/0
CACHE_REDIS_URL=redis://127.0.0.1:6379/2
USE_CELERY=True
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend   # + host/user/pass/port
DEFAULT_FROM_EMAIL=no-reply@example.com
# Optional max-isolation session model (needs the Redis policy in section 4):
# USE_OPAQUE_SESSIONS=True
```

Set `web/.env.production` (or the `Environment=` lines in `clubbooking-website.service`)
with `API_BASE_URL=http://127.0.0.1:8000/api/v1` and `SITE_URL=https://www.example.com`.

## 9. nginx + TLS

```bash
sudo cp /opt/clubbooking/deploy/nginx.conf /etc/nginx/sites-available/clubbooking
sudo ln -s /etc/nginx/sites-available/clubbooking /etc/nginx/sites-enabled/
# Edit hostnames/paths, then obtain certs:
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d admin.example.com -d www.example.com -d example.com
sudo nginx -t && sudo systemctl reload nginx
```

Ensure nginx (user `www-data`) can read the static/media dirs:
```bash
sudo chmod o+x /opt /opt/clubbooking /opt/clubbooking/frontend /opt/clubbooking/backend
```

## 10. Post-deploy hardening (flip when validated)

- **Enforce the SPA CSP:** in `nginx.conf`, once the admin app shows zero console
  violations, rename `Content-Security-Policy-Report-Only` → `Content-Security-Policy`
  (both the admin and website server blocks). Reload nginx.
- **Restrict the Google Maps key** in the Google Cloud console (HTTP-referrer +
  API restriction + billing budget) - see `frontend/.env.example`.
- Confirm `manage.py check --deploy` is clean.

---

## Redeploy (every release)

```bash
sudo -u clubbooking bash -lc '
  cd /opt/clubbooking && git pull &&
  ./venv/bin/pip install -r backend/requirements.txt &&
  cd backend && ../venv/bin/python manage.py migrate &&
  ../venv/bin/python manage.py collectstatic --noinput &&
  cd /opt/clubbooking/frontend && npm ci && npm run build &&
  cd /opt/clubbooking/web && npm ci && npm run build
'
sudo systemctl restart clubbooking-web clubbooking-worker clubbooking-beat clubbooking-website
```

## Operations

- **Logs:** `journalctl -u clubbooking-web -f` (or `-worker` / `-beat` / `-website`).
- **Backups:** nightly `pg_dump` (+ off-box copy); back up `backend/media/`.
- **Health:** `systemctl status clubbooking-*`; all units `Restart=always`.
- **Scale up:** raise `GUNICORN_WORKERS` (2*CPU+1) and `CELERY_CONCURRENCY`; move
  Postgres to a managed instance; front static + the website with a CDN.
- **One beat only:** never run more than one `clubbooking-beat` across the fleet.

## Performance notes

- Gunicorn uses `gthread` workers (2 threads each) - good for this IO-bound app.
  Workers recycle every ~1000 requests to cap memory.
- Hashed SPA/`_astro` assets are cached `immutable` for a year; `index.html` is
  never cached, so deploys go live immediately.
- Consider PgBouncer (transaction pooling) or `CONN_MAX_AGE` if worker count grows.
- Put Cloudflare (or any CDN) in front for edge TLS + caching of static assets and
  anonymous website pages; never cache `/api`.
