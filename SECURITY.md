# Security Overview — Authentication & Accounts

This document summarises the authentication security controls in the Club & Facility Booking
Management System. It reflects the hardened login/account stack.

## Authentication model

- **JWT (access + refresh)** via `djangorestframework-simplejwt`.
  - **Signing key**: a dedicated `JWT_SIGNING_KEY` (HS256) sourced from `.env`,
    kept **separate from Django's `SECRET_KEY`** so the two rotate independently.
    Secrets live only in `.env` (gitignored) — never in code. Production refuses
    to boot if either key is unset or a known default.
  - Access token lifetime: `JWT_ACCESS_MINUTES` (default 60 min).
  - Refresh token lifetime: `JWT_REFRESH_DAYS` (default 7 days).
  - **Refresh rotation** (`ROTATE_REFRESH_TOKENS`) + **blacklist after rotation**
    (`BLACKLIST_AFTER_ROTATION`): each refresh issues a new token and invalidates
    the old one.
  - `UPDATE_LAST_LOGIN` records each successful sign-in.
- **Email + password** login; identical generic errors so the API never reveals
  whether an email exists.
- **Server-side logout** (`POST /api/v1/auth/logout/`) blacklists the refresh
  token so a stolen copy cannot be reused. The SPA calls this on sign-out.

### Token storage — HttpOnly cookies (no tokens in JS)

Tokens are **never** exposed to JavaScript or stored in `localStorage`:

- On login the server sets `cw_access` and `cw_refresh` as **HttpOnly, Secure
  (prod), SameSite** cookies. The login response body contains only the user
  profile — no tokens. XSS therefore cannot read or exfiltrate a session.
- `CookieJWTAuthentication` reads the access token from the cookie. A standard
  `Authorization: Bearer` header is still accepted for non-browser clients
  (mobile/server-to-server).
- The refresh cookie is path-scoped to `/api/v1/auth/` so it is not sent on
  ordinary API requests. Refresh and logout read it server-side only.
- The SPA calls `/api/v1/auth/refresh/` (cookie-based) to rotate a stale access
  token; it holds **no** token material itself.

### CSRF protection

Because browser auth now rides on cookies, every unsafe (`POST/PUT/PATCH/DELETE`)
request is CSRF-protected:

- The server issues a readable `csrftoken` cookie (`GET /api/v1/auth/csrf/` and on
  login). The SPA echoes it in the `X-CSRFToken` header (axios does this
  automatically); `CookieJWTAuthentication` and `csrf_protect` reject mismatches.
- `CSRF_TRUSTED_ORIGINS` restricts which origins may submit. `SameSite=Lax`
  cookies are not sent on cross-site POSTs.
- Requests are same-origin with the SPA (the Vite dev server proxies `/api`,
  and production should serve the SPA and API behind one origin), which is what
  lets the HttpOnly cookies flow safely.

## Brute-force protection

- **Rate throttling** (DRF `ScopedRateThrottle`) on every sensitive endpoint:

  | Endpoint | Default rate (`.env`) |
  | --- | --- |
  | `auth/login/` | `THROTTLE_LOGIN` = 10/min |
  | `auth/mfa/*` | `THROTTLE_MFA` = 10/min |
  | `auth/register/` | `THROTTLE_REGISTER` = 5/min |
  | `auth/change-password/` | `THROTTLE_PASSWORD` = 5/min |

- **Account lockout**: after `LOGIN_MAX_FAILURES` (default 5) consecutive
  credential failures, the account is locked for `LOGIN_LOCKOUT_SECONDS`
  (default 15 min) — a correct password during the lock window still returns
  `429`. A successful login clears the counter.
- Throttle/lockout state is held in the cache. Use a **shared Redis cache**
  in production (`USE_REDIS_CACHE=True`) so limits hold across processes.
- Every failed login, lockout, logout, and MFA/password change is written to the
  **audit log**.

## Multi-factor authentication (TOTP)

- Standard **TOTP** (RFC 6238) via `pyotp`; works with Google Authenticator,
  Authy, 1Password, etc.
- Self-service enrolment returns a QR + manual key; MFA only activates after the
  user confirms a code.
- When enabled, **login requires a valid `otp`** — the API returns a `400` with
  an `otp` error so the client prompts for the code. OTP guessing is bounded by
  the login/MFA throttles.
- The TOTP secret is never exposed through any read API. Admins can reset a
  user's MFA (lost device); users disable their own MFA with a current code.

## Password policy

Enforced by `AUTH_PASSWORD_VALIDATORS` on registration, admin create, admin
reset, and self change-password:

- Minimum length `PASSWORD_MIN_LENGTH` (default **12**).
- Not similar to user attributes; not a common password; not all-numeric.
- **Complexity**: must include lower, upper, digit, and a symbol
  (`apps.accounts.validators.PasswordComplexityValidator`).

Passwords are stored with Django's default **PBKDF2** hasher.

## Role-based access control

- Seven roles (`super_admin`, `admin`, `club_admin`, `manager`, `facility_operator`, `facility_staff`,
  `customer`) enforced by DRF permission classes per endpoint and per-object.
- User-management and settings/audit endpoints are **admin/super-admin only**;
  the frontend mirrors this in `ProtectedRoute` and the sidebar.

### Capability permissions (module × action, editable role matrix + overrides)

- Permissions are **`<module>.<action>`** codes (e.g. `bookings.edit`,
  `payments.refund`, `settings.manage`) defined as a module × action catalogue
  in `apps/accounts/access.py`.
- Roles live in a **DB registry** (`RoleAccess`): the **Roles & Permissions
  master page** (`/roles`, admin-only) lists all roles and lets you **create
  custom roles** and **delete** them (when unused). Editing a role opens a
  separate page with the **module × action matrix**. The 6 defaults are seeded
  as **system roles** (non-deletable); `super_admin` is always full/​read-only,
  and editing the `admin` role requires `super_admin`.
- A **custom role maps to a base system role** (manager / facility_operator / facility_staff)
  that drives behaviour (staff-ness, site scoping); its capabilities come from
  its own editable matrix. A user stores both the behaviour role (`role`) and
  the assigned identity (`role_slug`).
- An admin can additionally **grant or revoke** individual capabilities per user
  (`permission_overrides`) when creating/editing a user.
- Effective set = `role permissions ∪ granted − revoked` (super_admin always
  full). Computed server-side (role sets cached + invalidated on edit), exposed
  on `/auth/me/` as `effective_permissions`, and enforced on sensitive endpoints
  (reports, audit, settings, payments charge/refund/membership). The frontend
  gates UI via `useAuth().hasPerm(code)`; the server is the source of truth.
- APIs (admin-only): `/auth/permissions-catalog/` (modules + role sets),
  `/auth/roles/` (list), `PUT /auth/roles/<role>/` (update a role's matrix).

### Club / facility scoping (data isolation)

- Staff carry **assigned clubs & facilities** (`User.assigned_clubs` /
  `assigned_facilities`). Bookings and facilities are linked to a `Club`, and
  `club_admin`/`manager`/`facility_operator`/`facility_staff` only see and act on
  data for their assigned clubs (club-less records stay visible).
  `super_admin`/`admin` are unrestricted. Enforced in the booking, club and
  facility querysets - not just hidden in the UI.

### Privilege-escalation & account safeguards (user management)

- **Public registration always creates a `customer`** — the requested role is
  ignored, so no authenticated caller can self-register a staff account.
- Only a **super admin** may create, promote to, or manage an `admin` /
  `super_admin` account; a regular admin cannot touch senior accounts.
- Nobody can **deactivate or delete their own account**; hard delete is
  super-admin-only and never removes the **last active super admin** (and is
  refused when related records exist — deactivate instead).
- **Sessions are invalidated** on password change, admin password reset, and
  deactivation: a `tokens_revoked_at` stamp makes the auth layer reject any
  access token issued earlier, and outstanding refresh tokens are blacklisted.
  A deactivated user is also rejected by simplejwt's active-user check.
- **MFA can only be disabled with a valid TOTP code** (the second factor); a
  stolen password alone cannot strip it. Lost-device cases are handled by an
  admin MFA reset (audited).
- Admin-created accounts get a strong random password (`secrets`), never a
  shared default.

## Single-origin architecture (Backend-for-Frontend)

The admin SPA and the REST API are served under **one public origin** by a reverse
proxy (`deploy/nginx.conf`). The browser talks only to the proxy; **Django binds to
an internal interface and is never publicly routable**, so the API host/topology is
not exposed. `/api` is proxied same-origin, which is what lets the HttpOnly auth
cookies flow with no CORS. Auth tokens are JWTs held in HttpOnly + Secure +
`SameSite` cookies (never in `localStorage`/`sessionStorage`), so XSS cannot read a
session. The public marketing site (`web/`) is a separate Astro SSR tier that
already proxies its own anonymous endpoints (browser → Astro `/api/*` → Django
`/website/public/*`), never calling Django directly.

Deploy env for this topology: `BEHIND_TLS_PROXY=True`, `NUM_PROXIES=1`,
real `DJANGO_ALLOWED_HOSTS`, and `CSRF_TRUSTED_ORIGINS=https://<dashboard-host>`.

**Opaque sessions (optional, `USE_OPAQUE_SESSIONS`).** The browser auth cookies
already hold JWTs that JS cannot read (HttpOnly). For maximum isolation, enable
`USE_OPAQUE_SESSIONS=True`: the cookie then carries only a random handle and the
JWT is held server-side (cache), so no JWT ever reaches the browser at all. All
existing validation/revocation is reused - the auth layer just resolves the handle
first. The `Authorization: Bearer` path (mobile) is unaffected. This needs a
shared, persistent, **non-evicting** cache (`USE_REDIS_CACHE=True`, Redis
`maxmemory-policy noeviction`) so live sessions survive restarts and aren't
evicted; it is off by default for a safe, opt-in rollout.

## Content-Security-Policy & response headers

- **API responses** (JSON) carry a strict `default-src 'none'` CSP - a data reply
  is never an executable document (`config/security_headers.py`).
- **The SPA document** carries a tuned CSP set by the reverse proxy (allows the
  Google Maps JS + `data:`/`blob:` image uploads + inline styles). It ships as
  `Content-Security-Policy-Report-Only`; verify zero violations in the browser
  console, then promote it to `Content-Security-Policy` to enforce.
- **Uploaded media** is served with `Content-Security-Policy: default-src 'none';
  sandbox` + `nosniff`, so a malicious SVG/HTML upload cannot execute.
- `Permissions-Policy` (unused browser features disabled) and
  `Cross-Origin-Opener-Policy: same-origin` are sent on every response.

## Transport & deployment hardening

Applied always: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`X-Frame-Options: DENY`, HttpOnly + `SameSite=Lax` session/CSRF cookies.

When `DJANGO_DEBUG=False` (production):

- **Boot-time guards refuse to start** with an insecure/default `SECRET_KEY` or
  with `*` in `ALLOWED_HOSTS`.
- HSTS (1 year, `includeSubDomains`, `preload`), SSL redirect, secure cookies.
- `BEHIND_TLS_PROXY=True` trusts `X-Forwarded-Proto` from a TLS-terminating proxy.

## Operational recommendations

- Generate a strong unique `DJANGO_SECRET_KEY` (≥ 50 chars) per environment.
- Run behind HTTPS only; set `USE_REDIS_CACHE=True` and a real `ALLOWED_HOSTS`.
- Serve the SPA and API under a single origin (or reverse proxy) in production
  so the HttpOnly auth cookies remain same-site; keep `AUTH_COOKIE_SECURE=True`
  (HTTPS) and set real `CSRF_TRUSTED_ORIGINS`.
- **Restrict the browser Google Maps key** (`VITE_GOOGLE_MAPS_API_KEY`) in the
  Google Cloud console: HTTP-referrer restriction to your admin host(s), API
  restriction to Maps JavaScript + Places only, and a billing budget/quota alert.
  It ships to the browser (not a secret), but must be locked to prevent billing
  abuse; use a separate restricted key per environment.
- Add async/Celery delivery + a SIEM feed of the audit log for production scale.
