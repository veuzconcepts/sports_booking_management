# Club & Facility Booking Management System

A booking and administration platform for clubs and the facilities they operate —
courts, pitches, lanes, halls and meeting spaces — built on a single Django REST
backend, a React admin dashboard, and an Astro customer website.

The domain reads top-down:

```
Club  ->  Facility Category  ->  Facility Type  ->  Facility  ->  Booking
(venue)   (merchandising)       (priced offer)     (court/lane)  (a slot)
```

---

## Tech Stack

| Layer | Stack |
| --- | --- |
| Backend | Django 5 · Django REST Framework · djangorestframework-simplejwt |
| Database | PostgreSQL 15+ (SQLite supported for quick local sanity) |
| Async | Celery + Redis · Django Channels |
| API Docs | drf-spectacular (Swagger / Redoc) |
| Admin UI | React 18 · Vite · React Router · Axios · React Hook Form |
| Website | Astro 4 (SSR, Node adapter) + React islands |
| Styling | Inter / Poppins · custom design tokens · lucide-react icons · recharts |

---

## Repository Layout

```
booking_management/
├── README.md
├── SECURITY.md
├── Procfile
├── backend/
│   ├── apps/
│   │   ├── accounts/        # Custom user, roles, JWT, RBAC
│   │   ├── customers/       # Customer profiles, addresses, loyalty ledger
│   │   ├── clubs/           # Clubs (venues) + weekday opening hours
│   │   ├── facilities/      # Categories, facility types, facilities, add-ons, pricing rules
│   │   ├── bookings/        # Booking lifecycle + the slot/availability engine
│   │   ├── staff/           # Staff profiles, shifts, club transfers
│   │   ├── payments/        # Payments, invoices, refunds, memberships, wallet
│   │   ├── promotions/      # Promo codes + redemptions
│   │   ├── loyalty/         # Loyalty configuration + tiers
│   │   ├── reports/         # Revenue / bookings / membership reporting
│   │   ├── notifications/   # Templates + delivery log
│   │   ├── auditlogs/       # Audit middleware + viewer
│   │   ├── customer_auth/   # Customer OTP / token authentication
│   │   ├── website/         # Public CMS + public booking endpoints
│   │   └── settings_app/    # Currency, tax, organization profile, booking rules
│   ├── config/              # settings, urls, wsgi, asgi, celery
│   ├── manage.py
│   ├── requirements.txt
│   └── .env.example
├── frontend/                # React admin dashboard (Vite)
└── web/                     # Astro customer website (SSR)
```

---

## Backend — local setup

```bash
cd backend

# 1. Create & activate a virtual environment
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
copy .env.example .env        # Windows
cp   .env.example .env        # macOS / Linux
# -> edit .env and set DB credentials

# 4. Create the PostgreSQL database (one-time)
# In psql:
#   CREATE DATABASE booking_management;
#
# OR for a quick first-run sanity check on SQLite, add to .env:
#   USE_SQLITE=True

# 5. Run migrations
python manage.py migrate

# 6. Seed demo data (idempotent)
python manage.py seed_demo
python manage.py seed_website

# 7. (Optional) create your own superuser
python manage.py createsuperuser

# 8. Run the dev server
python manage.py runserver 0.0.0.0:8000
```

The API is now at **http://127.0.0.1:8000/api/v1/** and the auto-generated
docs at **http://127.0.0.1:8000/api/docs/** (Super Admin only).

### Background jobs & scheduling

Async work runs through Celery. With `USE_CELERY=False` (the default) tasks run
inline in the calling process — no broker or worker needed for local dev/tests.

In production set `USE_CELERY=True`, point `REDIS_URL` at a broker, and run all
three Procfile processes:

```
web     # ASGI server (daphne)
worker  # Celery worker - invoice/receipt/credit-note PDFs, notifications
beat    # Celery beat - periodic jobs (see schedule below)
```

Periodic jobs (defined in `CELERY_BEAT_SCHEDULE`, run by the `beat` process):

| Job | Default time | Equivalent command | Lazy fallback |
| --- | --- | --- | --- |
| Expire memberships past their end date | 00:15 daily | `python manage.py expire_memberships` | yes — on membership list load |
| Activate due staff club transfers | 00:20 daily | `python manage.py activate_due_transfers` | yes — on Staff Details load |

Both jobs also activate lazily on the relevant page load and can be run by hand,
so a missed beat tick never loses state. If you don't run `beat`, run the two
`manage.py` commands from an external cron instead.

### Demo accounts

After running `seed_demo`, these staff accounts are available. The password for
all of them is **`DemoPass!2024`**.

| Email | Role |
| --- | --- |
| superadmin@example.com | super_admin |
| admin@example.com | admin |
| clubadmin@example.com | club_admin |
| manager@example.com | manager |
| operator@example.com | facility_operator |
| staff1@example.com | facility_staff |
| staff2@example.com | facility_staff |

### Key API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/login/` | Email + password → auth cookies + user |
| `POST` | `/api/v1/auth/refresh/` | Rotate the access token |
| `GET`  | `/api/v1/auth/me/` | Current user profile |
| `GET`  | `/api/v1/clubs/` | Clubs (venues) |
| `GET`  | `/api/v1/facilities/` | Physical facilities (courts, lanes, rooms) |
| `GET`  | `/api/v1/facilities/categories/` | Facility categories |
| `GET`  | `/api/v1/facilities/types/` | Bookable, priced facility types |
| `GET`  | `/api/v1/bookings/` | Bookings |
| `GET`  | `/api/v1/bookings/availability/` | Slot availability for a club + date |
| `GET`  | `/api/v1/customers/` | Customers |
| `GET`  | `/api/v1/website/public/catalogue/` | Public catalogue (no auth) |

---

## Admin dashboard — local setup

```bash
cd frontend

npm install
cp .env.example .env          # or `copy` on Windows
npm run dev
```

The admin dashboard is now at **http://localhost:5173**. Sign in with one of
the demo accounts above.

---

## Customer website — local setup

```bash
cd web

npm install
npm run dev
```

The website is now at **http://localhost:4321**. It reads live content and
availability from the Django public API (`API_BASE_URL`, default
`http://127.0.0.1:8000/api/v1`).

---

## Roles & Access

| Role | Scope |
| --- | --- |
| `super_admin` | Full access, system settings, billing |
| `admin` | Day-to-day operations across every club |
| `club_admin` | Admin-like, limited to their assigned clubs |
| `manager` | Bookings, staff and reports for assigned clubs |
| `facility_operator` | Booking queue and facility assignment |
| `facility_staff` | Bookings assigned to them |
| `customer` | Own bookings, payments and memberships |

Permissions are capability codes (`<module>.<action>`) resolved from an editable
role matrix plus per-user overrides — see
[`backend/apps/accounts/access.py`](backend/apps/accounts/access.py) and the DRF
permission classes in
[`backend/apps/accounts/permissions.py`](backend/apps/accounts/permissions.py).
The admin dashboard mirrors the same matrix in
[`frontend/src/routes/ProtectedRoute.jsx`](frontend/src/routes/ProtectedRoute.jsx)
and the sidebar.
